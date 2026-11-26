/**
 * Live platform checks (opt-in). Branch protection and environment
 * required reviewers live on the platform, not in the checkout, so
 * local evidence alone cannot prove them. These checks are OFF by
 * default; `audit --live` turns them on.
 *
 * Two sources, in order: the `gh` CLI (preferred - no token handling
 * at all), then the GitHub REST API with a read-only token taken ONLY
 * from the GITHUB_TOKEN environment variable. The token is never
 * accepted as an argv value, never printed, never logged, never
 * stored. A failed live check is UNKNOWN, never an error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LiveData } from "./types.js";

export interface RepoIdentity {
  owner: string | null;
  repo: string | null;
  defaultBranch: string;
  defaultBranchAssumed: boolean;
}

const REMOTE_RE =
  /(?:github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

export function detectRepo(dir: string, configDefault?: string): RepoIdentity {
  let owner: string | null = null;
  let repo: string | null = null;
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo && envRepo.includes("/")) {
    const [o, r] = envRepo.split("/", 2);
    owner = o;
    repo = r;
  }
  const configPath = join(dir, ".git", "config");
  if (existsSync(configPath)) {
    try {
      const text = readFileSync(configPath, "utf8");
      const m = text.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s);
      if (m) {
        const rm = m[1].match(REMOTE_RE);
        if (rm) {
          owner = rm[1];
          repo = rm[2];
        }
      }
    } catch {
      // unreadable git config: identity stays unknown, never fatal.
    }
  }
  let branch = configDefault ?? null;
  let assumed = configDefault === undefined;
  const headPath = join(dir, ".git", "HEAD");
  if (existsSync(headPath)) {
    try {
      const head = readFileSync(headPath, "utf8").trim();
      const hm = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (hm) {
        branch = hm[1];
        assumed = false;
      }
    } catch {
      // fall through to the default below
    }
  }
  if (!branch) {
    // Prefer main/master when they exist as local branches.
    const headsDir = join(dir, ".git", "refs", "heads");
    try {
      const heads = readdirSync(headsDir);
      if (heads.includes("main")) branch = "main";
      else if (heads.includes("master")) branch = "master";
    } catch {
      // no local branch refs: fall through
    }
  }
  if (!branch) {
    branch = "main";
    assumed = true;
  }
  return { owner, repo, defaultBranch: branch, defaultBranchAssumed: assumed };
}

function ghApi(path: string): unknown | null {
  try {
    const res = spawnSync("gh", ["api", path], {
      encoding: "utf8",
      timeout: 15000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    return JSON.parse(res.stdout) as unknown;
  } catch {
    return null;
  }
}

async function restApi(path: string, token: string): Promise<unknown | null> {
  try {
    const res = await fetch(`https://api.github.com/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pushpath",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function ghAvailable(): boolean {
  try {
    const res = spawnSync("gh", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Fetch branch protection + environment reviewers. Returns UNKNOWN
 * fields when live data is unavailable; never throws, never leaks
 * the token into any output.
 */
export async function fetchLive(
  owner: string | null,
  repo: string | null,
  branch: string,
  envNames: string[],
): Promise<LiveData> {
  const base: LiveData = {
    source: "none",
    branchProtection: "unknown",
    prReviewCount: null,
    envReviewers: {},
    repo: owner && repo ? `${owner}/${repo}` : null,
    checkedAt: null,
  };
  for (const env of envNames) base.envReviewers[env] = "unknown";
  if (!owner || !repo) return base;

  const useGh = ghAvailable();
  const token = process.env.GITHUB_TOKEN;
  if (!useGh && !token) return base;

  const get = async (path: string): Promise<unknown | null> => {
    if (useGh) return ghApi(path);
    if (token) return restApi(path, token);
    return null;
  };

  base.source = useGh ? "gh" : "api";
  base.checkedAt = new Date().toISOString();
  const protection = (await get(
    `repos/${owner}/${repo}/branches/${branch}/protection`,
  )) as {
    required_pull_request_reviews?: {
      required_approving_review_count?: number;
    };
  } | null;
  if (protection && protection.required_pull_request_reviews) {
    base.branchProtection = "required";
    base.prReviewCount =
      protection.required_pull_request_reviews
        .required_approving_review_count ?? 1;
  } else if (protection) {
    base.branchProtection = "not-required";
    base.prReviewCount = 0;
  }
  for (const env of envNames) {
    const rules = (await get(
      `repos/${owner}/${repo}/environments/${encodeURIComponent(env)}/protection_rules`,
    )) as Array<{ type?: string; reviewers?: unknown[] }> | null;
    if (Array.isArray(rules)) {
      const rr = rules.find((r) => r.type === "required_reviewers");
      base.envReviewers[env] =
        rr && Array.isArray(rr.reviewers) ? rr.reviewers.length : 0;
    }
  }
  return base;
}
