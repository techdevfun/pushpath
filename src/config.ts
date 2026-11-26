/** Policy file (pushpath.json) loading. The file is optional. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "./types.js";

export const DEFAULT_POLICY: Policy = {
  version: 1,
  failOnUnknown: false,
  requirePrReview: true,
  requireEnvironmentApprover: true,
  allowFloatingTags: false,
};

export function defaultPolicyJson(): string {
  return `{
  "_comment": "pushpath policy - created by 'pushpath init'. Edit freely; audit reads this file when it sits in the repo root or is passed with --policy.",
  "version": 1,
  "defaultBranch": "main",
  "failOnUnknown": false,
  "requirePrReview": true,
  "requireEnvironmentApprover": true,
  "allowFloatingTags": false,
  "ignoreWorkflows": []
}
`;
}

export function loadPolicy(
  explicitPath: string | undefined,
  repoDir: string,
): Policy {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(repoDir, "pushpath.json"), join(process.cwd(), "pushpath.json")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Policy>;
      return { ...DEFAULT_POLICY, ...raw };
    } catch {
      throw new Error(`could not parse policy file: ${path}`);
    }
  }
  return { ...DEFAULT_POLICY };
}
