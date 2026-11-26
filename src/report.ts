/** Human-readable audit report (table) and JSON output. */
import type { AuditResult } from "./types.js";

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

export function renderAudit(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`pushpath ${result.version} - deploy-path audit`);
  lines.push(`repo: ${result.repoDir}`);
  lines.push(
    `default branch: ${result.defaultBranch}${result.defaultBranchAssumed ? " (assumed - set defaultBranch in pushpath.json to override)" : ""}`,
  );
  lines.push(`workflows scanned: ${result.workflowsScanned}`);
  if (result.live.source !== "none") {
    lines.push(
      `live: ${result.live.source} - branch protection: ${result.live.branchProtection}${result.live.prReviewCount !== null ? ` (${result.live.prReviewCount} required review(s))` : ""}`,
    );
  } else {
    lines.push(
      "live: not checked (run with --live to verify branch protection and environment reviewers)",
    );
  }
  lines.push("");
  lines.push(`VERDICT: ${result.verdict}`);
  lines.push("");
  if (result.paths.length === 0) {
    lines.push("no deploy path found");
  } else {
    lines.push(
      "WORKFLOW                             JOB         TRIGGER           TARGET                VERDICT",
    );
    for (const p of result.paths) {
      lines.push(
        `${pad(p.workflow, 36)}${pad(p.job, 13)}${pad(p.trigger.detail, 18)}${pad(p.target, 22)}${p.verdict}`,
      );
      for (const e of p.evidence) {
        lines.push(`  ${e.file}:${e.line} [${e.kind}] ${e.detail}`);
      }
      for (const b of p.breakers) {
        lines.push(`  breaks: ${b}`);
      }
      for (const u of p.unverifiedControls) {
        lines.push(`  unverified: ${u}`);
      }
      if (p.environment) lines.push(`  environment: ${p.environment}`);
      lines.push("");
    }
  }
  if (result.findings.length > 0) {
    lines.push("FINDINGS");
    for (const f of result.findings) {
      const where = f.file ? `${f.file}:${f.line} ` : "";
      lines.push(`[${f.severity}] ${f.rule} ${where}- ${f.message}`);
    }
    lines.push("");
  }
  if (result.unknownWorkflows.length > 0) {
    lines.push("UNKNOWN WORKFLOWS (listed, not failed)");
    for (const u of result.unknownWorkflows) {
      lines.push(`  ${u.file}:${u.line} - ${u.reason}`);
    }
    lines.push("");
  }
  const solo = result.paths.filter((p) => p.verdict === "SOLO-PATH").length;
  const guarded = result.paths.filter((p) => p.verdict === "GUARDED").length;
  const unknown = result.paths.filter((p) => p.verdict === "UNKNOWN").length;
  lines.push(
    `summary: ${result.paths.length} deploy path(s) - ${solo} SOLO-PATH, ${guarded} GUARDED, ${unknown} UNKNOWN`,
  );
  return lines.join("\n");
}

export function renderGate(
  result: AuditResult,
  failOnUnknown: boolean,
): string {
  const lines: string[] = [];
  lines.push(`pushpath ${result.version} - CI gate`);
  lines.push(`verdict: ${result.verdict}`);
  for (const p of result.paths) {
    if (p.verdict === "SOLO-PATH") {
      lines.push(
        `SOLO-PATH: ${p.workflow} job '${p.job}' - ${p.trigger.detail} -> ${p.target}`,
      );
      for (const e of p.evidence) {
        lines.push(`  ${e.file}:${e.line} [${e.kind}] ${e.detail}`);
      }
      for (const u of p.unverifiedControls) {
        lines.push(`  unverified: ${u}`);
      }
    }
  }
  if (result.verdict === "UNKNOWN") {
    for (const p of result.paths) {
      if (p.verdict === "UNKNOWN") {
        lines.push(
          `UNKNOWN: ${p.workflow} job '${p.job}' - ${p.trigger.detail} -> ${p.target}`,
        );
      }
    }
    for (const u of result.unknownWorkflows) {
      lines.push(`UNKNOWN: ${u.file} - ${u.reason}`);
    }
  }
  if (result.verdict === "SOLO-PATH") {
    lines.push(
      "GATE FAILED: a solo deploy path exists - see 'pushpath explain solo-push'",
    );
  } else if (result.verdict === "UNKNOWN" && failOnUnknown) {
    lines.push("GATE FAILED: unknown deploy paths (--fail-on-unknown)");
  } else if (result.verdict === "UNKNOWN") {
    lines.push(
      "GATE PASSED with UNKNOWN paths (use --fail-on-unknown to fail on these)",
    );
  } else {
    lines.push("GATE PASSED: no solo deploy path");
  }
  return lines.join("\n");
}

export function toJson(result: AuditResult): string {
  return JSON.stringify(result, null, 2);
}
