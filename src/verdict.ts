/**
 * Path verdicts. The rule is deliberately conservative: a path is
 * GUARDED only when a breaking control is PROVEN (from the files or
 * from live platform data). When the breaking control lives on the
 * platform and live data is unavailable, the path is UNKNOWN, never
 * GUARDED. A solo path is SOLO-PATH only when no proven breaker
 * exists and the trigger can reach it from a push.
 */
import type { DeployPath, LiveData, Verdict } from "./types.js";

export interface PathVerdict {
  verdict: Verdict;
  breakers: string[];
  unverifiedControls: string[];
}

const LIVE_HINT = "run with --live to confirm";

export function computePathVerdict(
  path: Omit<DeployPath, "verdict" | "breakers" | "unverifiedControls" | "key">,
  live: LiveData,
): PathVerdict {
  const trigger = path.trigger;
  if (path.releaseGated) {
    return {
      verdict: "GUARDED",
      breakers: [
        "release-gated: the deploy job only runs on a release or tag event - creating a release or tag is the remaining single-account step, so protect tag and release creation",
      ],
      unverifiedControls: [],
    };
  }
  switch (trigger.kind) {
    case "release":
    case "push-tag":
      return {
        verdict: "GUARDED",
        breakers: [
          `${trigger.detail} gate: no push reaches this deploy job - creating a release or tag is the remaining single-account step, so protect tag and release creation`,
        ],
        unverifiedControls: [],
      };
    case "schedule":
      return {
        verdict: "GUARDED",
        breakers: ["schedule gate: no account action triggers this deploy job"],
        unverifiedControls: [],
      };
    case "other":
      return {
        verdict: "GUARDED",
        breakers: [`${trigger.detail} gate: no push reaches this deploy job`],
        unverifiedControls: [],
      };
    case "pull-request":
      return {
        verdict: "UNKNOWN",
        breakers: [],
        unverifiedControls: [
          `merge controls decide this path: whether a pull request can merge without review is platform data - ${LIVE_HINT}`,
        ],
      };
    case "manual":
      return {
        verdict: "UNKNOWN",
        breakers: [],
        unverifiedControls: [
          `manual trigger: a compromised account can still trigger it deliberately, so environment approvers decide this path - ${LIVE_HINT}`,
        ],
      };
    case "push": {
      if (live.branchProtection === "required") {
        return {
          verdict: "GUARDED",
          breakers: [
            `required PR review on the default branch (live, ${live.source}) - a push alone cannot land`,
          ],
          unverifiedControls: [],
        };
      }
      if (path.environment) {
        const reviewers = live.envReviewers[path.environment];
        if (typeof reviewers === "number" && reviewers >= 1) {
          return {
            verdict: "GUARDED",
            breakers: [
              `environment '${path.environment}' requires ${reviewers} approver(s) (live, ${live.source}) - a push alone cannot deploy`,
            ],
            unverifiedControls: [],
          };
        }
        if (typeof reviewers === "number" && reviewers === 0) {
          return {
            verdict: "SOLO-PATH",
            breakers: [],
            unverifiedControls:
              live.branchProtection === "unknown"
                ? [`branch protection unverified - ${LIVE_HINT}`]
                : [],
          };
        }
        return {
          verdict: "UNKNOWN",
          breakers: [],
          unverifiedControls: [
            `environment '${path.environment}' reviewers unverified - an approver would break this path, none is proven - ${LIVE_HINT}`,
          ],
        };
      }
      return {
        verdict: "SOLO-PATH",
        breakers: [],
        unverifiedControls:
          live.branchProtection === "unknown"
            ? [
                `branch protection unverified - a required PR review would break this path - ${LIVE_HINT}`,
              ]
            : [],
      };
    }
  }
}

export function overallVerdict(
  paths: DeployPath[],
  unknownWorkflows: number,
): Verdict {
  if (paths.some((p) => p.verdict === "SOLO-PATH")) return "SOLO-PATH";
  if (paths.some((p) => p.verdict === "UNKNOWN") || unknownWorkflows > 0) {
    return "UNKNOWN";
  }
  return "GUARDED";
}
