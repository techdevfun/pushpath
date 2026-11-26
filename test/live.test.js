import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** Live network check. Returns true when the host answers (any 2xx/3xx/4xx). */
async function networkUp(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

test("live: 1Password incident blog is reachable (fact source)", async (t) => {
  if (
    !(await networkUp(
      "https://1password.com/blog/update-on-nov-2026-security-incident",
    ))
  ) {
    t.skip("no network to 1password.com");
    return;
  }
  const res = await fetch(
    "https://1password.com/blog/update-on-nov-2026-security-incident",
    { signal: AbortSignal.timeout(10_000) },
  );
  assert.ok(
    res.status === 200 || res.status === 404,
    `unexpected status ${res.status}`,
  );
  if (res.status === 200) {
    const text = await res.text();
    assert.match(text, /November 19, 2026/);
    assert.match(text, /vault/);
  }
});

test("live: npm pushpath is still unclaimed (404)", async (t) => {
  if (!(await networkUp("https://registry.npmjs.org/pushpath"))) {
    t.skip("no network to the npm registry");
    return;
  }
  const res = await fetch("https://registry.npmjs.org/pushpath", {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(res.status, 404, "npm pushpath must be 404 (unclaimed)");
});

test("live: org repo techdevfun/pushpath is still 404 (private or absent)", async (t) => {
  if (!(await networkUp("https://api.github.com/repos/techdevfun/pushpath"))) {
    t.skip("no network to api.github.com");
    return;
  }
  const res = await fetch("https://api.github.com/repos/techdevfun/pushpath", {
    signal: AbortSignal.timeout(10_000),
  });
  // A private repo is 404 to unauthenticated reads, and 404 before creation.
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

async function getRealRepo(t) {
  const fromEnv = process.env.PUSHPATH_REAL_REPO;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (!(await networkUp("https://github.com/ossf/scorecard"))) {
    t.skip("no network to github.com and no PUSHPATH_REAL_REPO checkout");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "pushpath-scorecard-"));
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "https://github.com/ossf/scorecard.git", dir],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (clone.status !== 0) {
    t.skip("could not clone ossf/scorecard");
    return null;
  }
  return dir;
}

test("live: token is never printed, logged, or stored", async (t) => {
  const dir = await getRealRepo(t);
  if (!dir) return;
  const fake = "ghp_FAKE_TOKEN_0123456789abcdef";
  // Hide gh from PATH so the CLI takes the token path (GitHub API).
  const emptyBin = mkdtempSync(join(tmpdir(), "pushpath-nogh-"));
  const r = run(["audit", "--live", dir], {
    GITHUB_TOKEN: fake,
    PATH: emptyBin,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /VERDICT: GUARDED/);
  assert.doesNotMatch(r.stdout, /FAKE_TOKEN/);
  assert.doesNotMatch(r.stderr, /FAKE_TOKEN/);
  assert.match(r.stdout, /live: api - branch protection: unknown/);
});

test("live: real OSS repo audit (ossf/scorecard) is GUARDED with 0 unknown", async (t) => {
  const dir = await getRealRepo(t);
  if (!dir) return;
  const r = run(["audit", dir]);
  assert.equal(r.status, 0);
  const d = JSON.parse(run(["audit", "--json", dir]).stdout);
  assert.equal(d.verdict, "GUARDED");
  assert.equal(d.workflowsScanned, 17);
  assert.equal(d.unknownWorkflows.length, 0);
  assert.equal(d.paths.length, 2);
  assert.ok(d.paths.every((p) => p.verdict === "GUARDED"));
  assert.ok(d.paths.every((p) => p.trigger.kind === "push-tag"));
  const targets = d.paths.map((p) => p.target).sort();
  assert.deepEqual(targets, ["GitHub release", "container registry"]);
});
