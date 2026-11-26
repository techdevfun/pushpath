#!/usr/bin/env node
/**
 * pushpath CLI: trace the deploy path in a GitHub repo and answer one
 * question from local evidence - can a single compromised account walk
 * alone from push to production?
 *
 * Commands: init, audit, check, diff, explain. All support --json.
 * audit/check/diff/explain are 100% local; only --live touches the
 * network (gh CLI or a read-only token from GITHUB_TOKEN, never
 * printed, logged, or stored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultPolicyJson, loadPolicy } from "./config.js";
import { diffAudits, isRegression } from "./diff.js";
import { detectRepo, fetchLive } from "./live.js";
import { renderAudit, renderGate, toJson } from "./report.js";
import { INCIDENT_SUMMARY, RULES, findRule } from "./rules.js";
import { scanRepo, VERSION } from "./scan.js";
import type { AuditResult, LiveData, Policy } from "./types.js";

const USAGE = `pushpath ${VERSION} - can one compromised GitHub account walk alone from push to production?

Usage:
  pushpath init [dir]                 scaffold pushpath.json (policy template)
  pushpath audit [repo-dir] [--live] [--json] [--policy <file>] [--save-baseline <file>]
  pushpath check [repo-dir] [--live] [--json] [--fail-on-unknown] [--policy <file>]
  pushpath diff --baseline <file> [repo-dir] [--json] [--policy <file>]
  pushpath explain [rule]             list rules, or explain one (try: solo-push, 1password)

Exit codes: 0 guarded / no regression, 1 solo path / regression, 2 input error.
audit/check/diff/explain are 100% local. --live checks branch protection and
environment reviewers via the gh CLI (preferred) or a read-only GITHUB_TOKEN.
The token is never printed, logged, or stored.`;

interface Flags {
  json: boolean;
  live: boolean;
  failOnUnknown: boolean;
  policy?: string;
  baseline?: string;
  saveBaseline?: string;
  positional: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    json: false,
    live: false,
    failOnUnknown: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--live") flags.live = true;
    else if (a === "--fail-on-unknown") flags.failOnUnknown = true;
    else if (a === "--policy") flags.policy = args[++i];
    else if (a === "--baseline") flags.baseline = args[++i];
    else if (a === "--save-baseline") flags.saveBaseline = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      console.error(USAGE);
      process.exit(2);
    } else {
      flags.positional.push(a);
    }
  }
  return flags;
}

const NO_LIVE: LiveData = {
  source: "none",
  branchProtection: "unknown",
  prReviewCount: null,
  envReviewers: {},
  repo: null,
  checkedAt: null,
};

async function runAudit(
  repoDir: string,
  flags: Flags,
  policy: Policy,
): Promise<AuditResult> {
  const abs = resolve(repoDir);
  if (!existsSync(abs)) {
    throw new Error(`repo directory does not exist: ${repoDir}`);
  }
  const identity = detectRepo(abs, policy.defaultBranch);
  let live: LiveData = NO_LIVE;
  if (flags.live) {
    // Environment names are only known after scanning, so scan once
    // offline to learn them, then fetch live data and scan again.
    const first = scanRepo({
      repoDir,
      defaultBranch: identity.defaultBranch,
      defaultBranchAssumed: identity.defaultBranchAssumed,
      policy,
      live: NO_LIVE,
    });
    const envNames = [
      ...new Set(
        first.paths
          .map((p) => p.environment)
          .filter((e): e is string => e !== null),
      ),
    ];
    live = await fetchLive(
      identity.owner,
      identity.repo,
      identity.defaultBranch,
      envNames,
    );
  }
  return scanRepo({
    repoDir,
    defaultBranch: identity.defaultBranch,
    defaultBranchAssumed: identity.defaultBranchAssumed,
    policy,
    live,
  });
}

function exitFor(result: AuditResult, failOnUnknown: boolean): number {
  if (result.verdict === "SOLO-PATH") return 1;
  if (result.verdict === "UNKNOWN" && failOnUnknown) return 1;
  return 0;
}

function cmdInit(dir: string): number {
  const abs = resolve(dir);
  mkdirSync(abs, { recursive: true });
  const target = join(abs, "pushpath.json");
  if (existsSync(target)) {
    console.error(`pushpath.json already exists in ${dir} - not overwriting`);
    return 2;
  }
  writeFileSync(target, defaultPolicyJson());
  console.log(`created ${join(dir, "pushpath.json")}`);
  console.log(
    "Next: run 'pushpath audit .' to trace the deploy paths in this repo.",
  );
  return 0;
}

function cmdExplain(arg: string | undefined): number {
  if (!arg) {
    console.log("pushpath rules (run 'pushpath explain <rule>' for detail):");
    for (const r of RULES) {
      console.log(`  ${r.id} - ${r.title}`);
    }
    console.log(
      "  1password - the 25/11/2026 incident this tool is built around",
    );
    return 0;
  }
  if (arg === "1password") {
    console.log(
      "The 1Password incident (25/11/2026) - why the deploy path matters:",
    );
    for (const line of INCIDENT_SUMMARY) {
      console.log(`- ${line}`);
    }
    return 0;
  }
  const rule = findRule(arg);
  if (!rule) {
    console.error(`unknown rule: ${arg}`);
    console.error(
      "known rules: " + RULES.map((r) => r.id).join(", ") + ", 1password",
    );
    return 2;
  }
  console.log(`${rule.id} - ${rule.title}`);
  console.log("");
  console.log(`What: ${rule.what}`);
  console.log("");
  console.log(`Fix: ${rule.fix}`);
  console.log("");
  console.log(`Why it matters: ${rule.anchor}`);
  return 0;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "init") {
    const flags = parseFlags(rest);
    return cmdInit(flags.positional[0] ?? ".");
  }
  if (command === "explain") {
    const flags = parseFlags(rest);
    if (flags.json) {
      const arg = flags.positional[0];
      if (arg === "1password") {
        console.log(JSON.stringify({ incident: INCIDENT_SUMMARY }, null, 2));
        return 0;
      }
      const rule = arg ? findRule(arg) : undefined;
      if (arg && !rule) {
        console.error(`unknown rule: ${arg}`);
        return 2;
      }
      console.log(JSON.stringify(rule ?? RULES, null, 2));
      return 0;
    }
    return cmdExplain(flags.positional[0]);
  }
  if (command === "audit" || command === "check") {
    const flags = parseFlags(rest);
    const repoDir = flags.positional[0] ?? ".";
    let policy: Policy;
    try {
      policy = loadPolicy(flags.policy, resolve(repoDir));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    if (flags.failOnUnknown) policy = { ...policy, failOnUnknown: true };
    let result: AuditResult;
    try {
      result = await runAudit(repoDir, flags, policy);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    if (flags.saveBaseline) {
      writeFileSync(flags.saveBaseline, toJson(result));
    }
    if (flags.json) {
      console.log(toJson(result));
    } else if (command === "audit") {
      console.log(renderAudit(result));
    } else {
      console.log(renderGate(result, policy.failOnUnknown ?? false));
    }
    return exitFor(result, policy.failOnUnknown ?? false);
  }
  if (command === "diff") {
    const flags = parseFlags(rest);
    if (!flags.baseline) {
      console.error("diff requires --baseline <file>");
      return 2;
    }
    const repoDir = flags.positional[0] ?? ".";
    let policy: Policy;
    try {
      policy = loadPolicy(flags.policy, resolve(repoDir));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    let baseline: AuditResult;
    try {
      baseline = JSON.parse(
        readFileSync(flags.baseline, "utf8"),
      ) as AuditResult;
    } catch {
      console.error(`could not read baseline file: ${flags.baseline}`);
      return 2;
    }
    let current: AuditResult;
    try {
      current = await runAudit(repoDir, flags, policy);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
    const d = diffAudits(baseline, current);
    const regression = isRegression(d);
    if (flags.json) {
      console.log(JSON.stringify({ ...d, regression }, null, 2));
    } else {
      console.log(`pushpath ${VERSION} - baseline diff`);
      console.log(`baseline: ${flags.baseline} (verdict ${baseline.verdict})`);
      console.log(`current: ${repoDir} (verdict ${current.verdict})`);
      if (d.addedSolo.length > 0) {
        console.log("new solo path(s):");
        for (const k of d.addedSolo) console.log(`  + ${k}`);
      }
      if (d.resolvedSolo.length > 0) {
        console.log("resolved solo path(s):");
        for (const k of d.resolvedSolo) console.log(`  - ${k}`);
      }
      if (d.addedUnknown.length > 0) {
        console.log("new unknown path(s):");
        for (const k of d.addedUnknown) console.log(`  ? ${k}`);
      }
      for (const v of d.verdictChanges) {
        console.log(`verdict change: ${v.key}: ${v.from} -> ${v.to}`);
      }
      if (regression) {
        console.log("REGRESSION: a new solo deploy path appeared");
      } else {
        console.log("no regressions");
      }
    }
    return regression ? 1 : 0;
  }
  console.error(`unknown command: ${command}`);
  console.error(USAGE);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
