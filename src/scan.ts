/**
 * Local workflow scanner: reads .github/workflows/*.yml|yaml from a
 * checkout, parses them with the YAML-subset parser, and traces every
 * deploy path (trigger -> file:line -> job/environment -> target).
 * 100% offline. Reads file text only; never executes anything.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  DEPLOY_ACTIONS,
  DEPLOY_COMMANDS,
  REMOTE_STEP_RE,
  inferTargetFromName,
  isShaPinned,
  jobNameLooksDeploy,
  splitUses,
} from "./deploy.js";
import type {
  AuditResult,
  DeployPath,
  Evidence,
  Finding,
  LiveData,
  Policy,
  TriggerInfo,
  UnknownWorkflow,
  Verdict,
} from "./types.js";
import { computePathVerdict, overallVerdict } from "./verdict.js";
import {
  asString,
  asStringList,
  getKeyLine,
  getMap,
  mapEntries,
  parseYaml,
  YamlParseError,
  type YamlNode,
} from "./yaml.js";

export const VERSION = "0.1.0";

const WRITE_SCOPES = new Set([
  "contents",
  "deployments",
  "packages",
  "actions",
  "checks",
  "statuses",
  "issues",
  "pull-requests",
  "id-token",
  "pages",
  "security-events",
  "administration",
]);

/** GitHub branch-pattern glob: ** -> any, * -> no slash, ? -> one char. */
export function globMatch(pattern: string, value: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re).test(value);
}

function parseTrigger(
  onNode: YamlNode | undefined,
  defaultBranch: string,
  onLine: number,
): TriggerInfo {
  if (!onNode) {
    return {
      kind: "other",
      detail: "no trigger (workflow never runs)",
      line: onLine,
      reachesDefault: false,
    };
  }
  // Scalar form: `on: push` or `on: [push, pull_request]`.
  const events: string[] = [];
  if (onNode.kind === "scalar") {
    const s = onNode.scalar ?? "";
    if (s !== "") events.push(s);
  } else if (onNode.kind === "seq") {
    for (const item of onNode.seq ?? []) {
      if (item.kind === "scalar" && item.scalar) events.push(item.scalar);
    }
  }
  if (events.length > 0) {
    return triggerFromEvents(events, undefined, defaultBranch, onNode.line);
  }
  // Map form: `on:\n  push:\n    branches: [main]`.
  const keys = mapEntries(onNode).map((e) => e.key);
  const pushNode = getMap(onNode, "push");
  return triggerFromEvents(keys, pushNode, defaultBranch, onNode.line);
}

function triggerFromEvents(
  events: string[],
  pushNode: YamlNode | undefined,
  defaultBranch: string,
  line: number,
): TriggerInfo {
  if (events.includes("push") && pushNode) {
    const branches = asStringList(getMap(pushNode, "branches"));
    const tags = asStringList(getMap(pushNode, "tags"));
    const ignored = asStringList(getMap(pushNode, "branches-ignore"));
    if (branches.length === 0 && tags.length > 0) {
      return {
        kind: "push-tag",
        detail: `push tags ${tags.join(", ")}`,
        line,
        reachesDefault: false,
      };
    }
    if (branches.length > 0) {
      const reaches = branches.some((p) => globMatch(p, defaultBranch));
      return {
        kind: "push",
        detail: `push to ${branches.join(", ")}`,
        line,
        reachesDefault: reaches,
      };
    }
    if (ignored.length > 0) {
      const reaches = !ignored.some((p) => globMatch(p, defaultBranch));
      return {
        kind: "push",
        detail: `push to any branch except ${ignored.join(", ")}`,
        line,
        reachesDefault: reaches,
      };
    }
    return {
      kind: "push",
      detail: "push to any branch",
      line,
      reachesDefault: true,
    };
  }
  if (events.includes("push")) {
    return {
      kind: "push",
      detail: "push to any branch",
      line,
      reachesDefault: true,
    };
  }
  if (events.includes("pull_request")) {
    return {
      kind: "pull-request",
      detail: "pull_request",
      line,
      reachesDefault: false,
    };
  }
  if (
    events.includes("workflow_dispatch") ||
    events.includes("workflow_call")
  ) {
    const which = events.includes("workflow_dispatch")
      ? "workflow_dispatch"
      : "workflow_call";
    return { kind: "manual", detail: which, line, reachesDefault: false };
  }
  if (events.includes("release")) {
    return { kind: "release", detail: "release", line, reachesDefault: false };
  }
  if (events.includes("schedule")) {
    return {
      kind: "schedule",
      detail: "schedule",
      line,
      reachesDefault: false,
    };
  }
  return {
    kind: "other",
    detail: events.length > 0 ? events.join(", ") : "no trigger",
    line,
    reachesDefault: false,
  };
}

const RELEASE_GATE_RE =
  /github\.event_name\s*==\s*['"]release['"]|startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\//;

export interface JobAnalysis {
  isDeploy: boolean;
  target: string | null;
  evidence: Evidence[];
  environment: string | null;
  releaseGated: boolean;
  unreviewedSteps: Evidence[];
}

/** Analyze one job node. `file` is the display path used in evidence. */
function analyzeJob(
  jobId: string,
  jobNode: YamlNode,
  file: string,
  jobLine: number,
): JobAnalysis {
  const evidence: Evidence[] = [];
  const unreviewedSteps: Evidence[] = [];
  let isDeploy = false;
  // The job name gives a weak target guess; a deploy step that names a
  // concrete target always wins over the name guess.
  let nameTarget: string | null = null;
  let stepTarget: string | null = null;
  const jobName = asString(getMap(jobNode, "name"));
  if (jobNameLooksDeploy(jobId, jobName)) {
    isDeploy = true;
    nameTarget = inferTargetFromName(jobName ?? jobId);
    evidence.push({
      file,
      line: jobLine,
      kind: "job-name",
      detail: `job '${jobId}' is named for deploy/publish/release`,
    });
  }
  const envNode = getMap(jobNode, "environment");
  let environment: string | null = null;
  if (envNode) {
    if (envNode.kind === "scalar") {
      environment = envNode.scalar ?? null;
    } else {
      environment = asString(getMap(envNode, "name")) ?? null;
    }
    if (environment) {
      evidence.push({
        file,
        line: envNode.line,
        kind: "environment",
        detail: `job uses environment '${environment}'`,
      });
    }
  }
  const ifNode = getMap(jobNode, "if");
  const ifText = asString(ifNode) ?? "";
  const releaseGated = RELEASE_GATE_RE.test(ifText);
  if (releaseGated) {
    evidence.push({
      file,
      line: ifNode?.line ?? jobLine,
      kind: "release-gate",
      detail: `job runs only on a release or tag event (${ifText})`,
    });
  }
  const stepsNode = getMap(jobNode, "steps");
  if (stepsNode && stepsNode.kind === "seq") {
    for (const step of stepsNode.seq ?? []) {
      if (step.kind !== "map") continue;
      const uses = asString(getMap(step, "uses"));
      const run = asString(getMap(step, "run"));
      const stepName = asString(getMap(step, "name")) ?? "";
      if (uses) {
        const usesLine = getKeyLine(step, "uses");
        // Job-level reusable workflow call (uses: owner/repo/.github/...) is
        // recorded but not traced in v0.1.0; step-level uses are actions.
        const { path: actionPath } = splitUses(uses) ?? { path: uses, ref: "" };
        const rule = DEPLOY_ACTIONS.find((r) =>
          actionPath.toLowerCase().includes(r.substr),
        );
        if (rule) {
          isDeploy = true;
          stepTarget = stepTarget ?? rule.target;
          evidence.push({
            file,
            line: usesLine,
            kind: "deploy-action",
            detail: `${rule.label} (${uses})`,
          });
        }
      }
      if (run) {
        const runLine = getKeyLine(step, "run");
        const cmd = DEPLOY_COMMANDS.find((c) => c.re.test(run));
        if (cmd) {
          isDeploy = true;
          stepTarget = stepTarget ?? cmd.target;
          evidence.push({
            file,
            line: runLine,
            kind: "deploy-command",
            detail: `${cmd.label}: ${run.split("\n")[0].trim().slice(0, 80)}`,
          });
        } else if (isDeploy && REMOTE_STEP_RE.test(run)) {
          unreviewedSteps.push({
            file,
            line: runLine,
            kind: "unreviewed-step",
            detail: `remote-affecting run step in a deploy job (${stepName || "unnamed step"}): ${run.split("\n")[0].trim().slice(0, 80)}`,
          });
        }
      }
    }
  }
  // A job-level `uses:` means the job calls a reusable workflow: the
  // deploy happens inside the called workflow, which v0.1.0 does not
  // trace. Record it as evidence, not as a deploy job by itself.
  const jobUses = asString(getMap(jobNode, "uses"));
  if (jobUses) {
    evidence.push({
      file,
      line: getKeyLine(jobNode, "uses"),
      kind: "reusable-workflow",
      detail: `job calls reusable workflow ${jobUses} (deploy inside the called workflow is not traced in v0.1.0)`,
    });
  }
  if (!stepTarget && !nameTarget && isDeploy)
    nameTarget = inferTargetFromName(jobName ?? jobId);
  const target = stepTarget ?? nameTarget;
  return {
    isDeploy,
    target,
    evidence,
    environment,
    releaseGated,
    unreviewedSteps,
  };
}

function analyzePermissions(
  permsNode: YamlNode | undefined,
  scope: string,
  file: string,
  findings: Finding[],
): void {
  if (!permsNode) return;
  if (permsNode.kind === "scalar") {
    const v = (permsNode.scalar ?? "").toLowerCase();
    if (v === "write-all") {
      findings.push({
        rule: "least-privilege",
        severity: "high",
        file,
        line: permsNode.line,
        message: `${scope} permissions: write-all grants every scope`,
      });
    }
    return;
  }
  if (permsNode.kind !== "map") return;
  const writes: string[] = [];
  for (const { key, value } of mapEntries(permsNode)) {
    const v = (asString(value) ?? "").toLowerCase();
    if (v === "write" && WRITE_SCOPES.has(key)) writes.push(key);
  }
  if (writes.length > 0) {
    findings.push({
      rule: "least-privilege",
      severity: scope === "top-level" ? "medium" : "info",
      file,
      line: permsNode.line,
      message: `${scope} permissions grant write: ${writes.join(", ")}`,
    });
  }
}

const SECRET_RE = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g;

export function findWorkflowFiles(dir: string): string[] {
  const wfDir = join(dir, ".github", "workflows");
  if (!existsSync(wfDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(wfDir)) {
    if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
      out.push(join(wfDir, entry));
    }
  }
  return out.sort();
}

export interface ScanOptions {
  repoDir: string;
  defaultBranch: string;
  defaultBranchAssumed: boolean;
  policy: Policy;
  live: LiveData;
}

/** Full local audit of one checkout. Never throws on bad input files. */
export function scanRepo(opts: ScanOptions): AuditResult {
  const paths: DeployPath[] = [];
  const findings: Finding[] = [];
  const unknownWorkflows: UnknownWorkflow[] = [];
  const files = findWorkflowFiles(opts.repoDir);
  let workflowsScanned = 0;

  for (const full of files) {
    const display = `.github/workflows/${basename(full)}`;
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      unknownWorkflows.push({
        file: display,
        line: 1,
        reason: "could not read file",
      });
      continue;
    }
    let doc: YamlNode;
    try {
      doc = parseYaml(text);
    } catch (err) {
      const reason =
        err instanceof YamlParseError
          ? err.message
          : "could not parse workflow YAML";
      unknownWorkflows.push({ file: display, line: 1, reason });
      continue;
    }
    workflowsScanned++;
    if (opts.policy.ignoreWorkflows?.some((p) => display.includes(p))) continue;

    const onNode = getMap(doc, "on");
    const trigger = parseTrigger(
      onNode,
      opts.defaultBranch,
      getKeyLine(doc, "on"),
    );
    analyzePermissions(
      getMap(doc, "permissions"),
      "top-level",
      display,
      findings,
    );

    // Secret NAMES only - never values. Values are never read or printed.
    const secretNames = new Set<string>();
    for (const m of text.matchAll(SECRET_RE)) secretNames.add(m[1]);
    if (secretNames.size > 0) {
      const lineNo =
        text.split("\n").findIndex((l) => l.includes("secrets.")) + 1;
      findings.push({
        rule: "secret-names",
        severity: "info",
        file: display,
        line: Math.max(lineNo, 1),
        message: `workflow references secret names (names only, values never read): ${[...secretNames].sort().join(", ")}`,
      });
    }

    // Action pinning: every step-level and job-level `uses:`.
    const checkUses = (uses: string, line: number) => {
      if (uses.startsWith("./") || uses.startsWith("docker://")) {
        if (uses.startsWith("docker://") && /:latest$/.test(uses)) {
          findings.push({
            rule: "pin-actions",
            severity: "medium",
            file: display,
            line,
            message: `docker action uses the floating :latest tag (${uses})`,
          });
        }
        return;
      }
      const parts = splitUses(uses);
      if (!parts) return;
      if (!isShaPinned(parts.ref)) {
        if (opts.policy.allowFloatingTags) {
          findings.push({
            rule: "pin-actions",
            severity: "info",
            file: display,
            line,
            message: `third-party action uses a floating ref (${uses})`,
          });
        } else {
          findings.push({
            rule: "pin-actions",
            severity: "medium",
            file: display,
            line,
            message: `third-party action is not SHA-pinned (${uses}) - a floating tag can move under you`,
          });
        }
      }
    };

    const jobsNode = getMap(doc, "jobs");
    if (!jobsNode || jobsNode.kind !== "map") continue;
    for (const { key: jobId, value: jobNode } of mapEntries(jobsNode)) {
      if (jobNode.kind !== "map") continue;
      const jobLine = getKeyLine(jobsNode, jobId);
      const stepsNode = getMap(jobNode, "steps");
      if (stepsNode && stepsNode.kind === "seq") {
        for (const step of stepsNode.seq ?? []) {
          if (step.kind !== "map") continue;
          const uses = asString(getMap(step, "uses"));
          if (uses) checkUses(uses, getKeyLine(step, "uses"));
        }
      }
      const jobUses = asString(getMap(jobNode, "uses"));
      if (jobUses) checkUses(jobUses, getKeyLine(jobNode, "uses"));

      analyzePermissions(
        getMap(jobNode, "permissions"),
        `job '${jobId}'`,
        display,
        findings,
      );

      const job = analyzeJob(jobId, jobNode, display, jobLine);
      for (const u of job.unreviewedSteps) {
        findings.push({
          rule: "unreviewed-step",
          severity: "medium",
          file: u.file,
          line: u.line,
          message: u.detail,
        });
      }
      if (!job.isDeploy) continue;
      if (
        opts.policy.requireEnvironmentApprover &&
        !job.environment &&
        trigger.kind === "push"
      ) {
        findings.push({
          rule: "env-approver",
          severity: "medium",
          file: display,
          line: jobLine,
          message: `deploy job '${jobId}' has no environment - nothing stands between a push and production`,
        });
      }
      const key = `${display}:${jobId}:${job.target ?? "production"}`;
      const bare = {
        workflow: display,
        job: jobId,
        jobLine,
        environment: job.environment,
        target: job.target ?? "production (unspecified)",
        trigger,
        releaseGated: job.releaseGated,
        evidence: job.evidence,
      };
      const v = computePathVerdict(bare, opts.live);
      paths.push({
        key,
        ...bare,
        verdict: v.verdict,
        breakers: v.breakers,
        unverifiedControls: v.unverifiedControls,
      });
    }
  }

  // Policy: a required PR review that live data says is missing.
  if (
    opts.policy.requirePrReview &&
    opts.live.branchProtection === "not-required"
  ) {
    findings.push({
      rule: "pr-review",
      severity: "high",
      file: "",
      line: 0,
      message: `policy requires PR review, but live branch protection on '${opts.defaultBranch}' does not require it`,
    });
  }

  const verdict: Verdict = overallVerdict(paths, unknownWorkflows.length);
  return {
    tool: "pushpath",
    version: VERSION,
    repoDir: opts.repoDir,
    defaultBranch: opts.defaultBranch,
    defaultBranchAssumed: opts.defaultBranchAssumed,
    verdict,
    paths,
    findings,
    unknownWorkflows,
    workflowsScanned,
    live: opts.live,
    generatedAt: new Date().toISOString().slice(0, 10),
  };
}
