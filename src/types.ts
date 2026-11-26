/** Shared types for pushpath. */

export type Verdict = "SOLO-PATH" | "GUARDED" | "UNKNOWN";

export type TriggerKind =
  | "push"
  | "push-tag"
  | "release"
  | "pull-request"
  | "manual"
  | "schedule"
  | "other";

export interface TriggerInfo {
  kind: TriggerKind;
  /** Human-readable trigger detail, e.g. "push to main" or "push tags v*". */
  detail: string;
  /** Line of the trigger key in the workflow file (1-based). */
  line: number;
  /** True when a push trigger can reach the default branch. */
  reachesDefault: boolean;
}

export interface Evidence {
  file: string;
  line: number;
  kind: string;
  detail: string;
}

export interface DeployPath {
  key: string;
  workflow: string;
  job: string;
  jobLine: number;
  environment: string | null;
  target: string;
  trigger: TriggerInfo;
  verdict: Verdict;
  /** True when the job only runs on a release/tag event (job-level if:). */
  releaseGated: boolean;
  /** Controls proven to break this path (empty when SOLO-PATH). */
  breakers: string[];
  /** Controls that could break this path but could not be verified locally. */
  unverifiedControls: string[];
  evidence: Evidence[];
}

export interface Finding {
  rule: string;
  severity: "high" | "medium" | "low" | "info";
  file: string;
  line: number;
  message: string;
}

export interface UnknownWorkflow {
  file: string;
  line: number;
  reason: string;
}

export interface LiveData {
  source: "gh" | "api" | "none";
  branchProtection: "required" | "not-required" | "unknown";
  prReviewCount: number | null;
  /** Environment name -> required reviewer count, or "unknown". */
  envReviewers: Record<string, number | "unknown">;
  repo: string | null;
  checkedAt: string | null;
}

export interface AuditResult {
  tool: string;
  version: string;
  repoDir: string;
  defaultBranch: string;
  defaultBranchAssumed: boolean;
  verdict: Verdict;
  paths: DeployPath[];
  findings: Finding[];
  unknownWorkflows: UnknownWorkflow[];
  workflowsScanned: number;
  live: LiveData;
  generatedAt: string;
}

export interface Policy {
  version: number;
  defaultBranch?: string;
  failOnUnknown?: boolean;
  requirePrReview?: boolean;
  requireEnvironmentApprover?: boolean;
  allowFloatingTags?: boolean;
  ignoreWorkflows?: string[];
}
