import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const EXAMPLES = join(ROOT, "examples");

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("e2e: audit solo-repo exits 1 with a named solo path", () => {
  const r = run(["audit", join(EXAMPLES, "solo-repo")]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /VERDICT: SOLO-PATH/);
  assert.match(r.stdout, /push to main/);
  assert.match(r.stdout, /npm registry/);
  assert.match(r.stdout, /deploy\.yml:\d+ \[deploy-command\] npm publish/);
  assert.match(r.stdout, /unverified: branch protection unverified/);
});

test("e2e: check solo-repo exits 1 with a compact gate result", () => {
  const r = run(["check", join(EXAMPLES, "solo-repo")]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /GATE FAILED: a solo deploy path exists/);
  assert.match(
    r.stdout,
    /SOLO-PATH: .github\/workflows\/deploy\.yml job 'deploy'/,
  );
});

test("e2e: audit guarded-repo exits 0", () => {
  const r = run(["audit", join(EXAMPLES, "guarded-repo")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /VERDICT: GUARDED/);
  assert.match(r.stdout, /push tags v\* gate/);
});

test("e2e: audit env-repo exits 0 with UNKNOWN (no live data)", () => {
  const r = run(["audit", join(EXAMPLES, "env-repo")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /VERDICT: UNKNOWN/);
  assert.match(r.stdout, /environment 'production' reviewers unverified/);
});

test("e2e: check --fail-on-unknown fails on UNKNOWN", () => {
  const r = run(["check", "--fail-on-unknown", join(EXAMPLES, "env-repo")]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /GATE FAILED: unknown deploy paths/);
});

test("e2e: audit weird-repo exits 0, lists the file, never crashes", () => {
  const r = run(["audit", join(EXAMPLES, "weird-repo")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /VERDICT: UNKNOWN/);
  assert.match(r.stdout, /UNKNOWN WORKFLOWS/);
  assert.match(r.stdout, /duplicate key: push/);
});

test("e2e: audit --json is machine-readable and complete", () => {
  const r = run(["audit", "--json", join(EXAMPLES, "solo-repo")]);
  assert.equal(r.status, 1);
  const d = JSON.parse(r.stdout);
  assert.equal(d.tool, "pushpath");
  assert.equal(d.version, "0.1.0");
  assert.equal(d.verdict, "SOLO-PATH");
  assert.equal(d.paths.length, 1);
  assert.equal(d.paths[0].job, "deploy");
  assert.equal(d.paths[0].target, "npm registry");
  assert.equal(d.workflowsScanned, 1);
  assert.equal(d.defaultBranch, "main");
  assert.equal(d.live.source, "none");
  assert.ok(Array.isArray(d.findings));
  assert.ok(d.findings.some((f) => f.rule === "pin-actions"));
});

test("e2e: diff detects a new solo path as a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "pushpath-diff-"));
  const guardedBaseline = join(dir, "guarded-baseline.json");
  const ok = run([
    "audit",
    "--json",
    "--save-baseline",
    guardedBaseline,
    join(EXAMPLES, "guarded-repo"),
  ]);
  assert.equal(ok.status, 0);
  assert.ok(existsSync(guardedBaseline));
  const noRegression = run([
    "diff",
    "--baseline",
    guardedBaseline,
    join(EXAMPLES, "guarded-repo"),
  ]);
  assert.equal(noRegression.status, 0);
  assert.match(noRegression.stdout, /no regressions/);
  const regression = run([
    "diff",
    "--baseline",
    guardedBaseline,
    join(EXAMPLES, "solo-repo"),
  ]);
  assert.equal(regression.status, 1);
  assert.match(regression.stdout, /REGRESSION/);
  assert.match(regression.stdout, /new solo path/);
});

test("e2e: diff --json reports the regression flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "pushpath-diff-json-"));
  const baseline = join(dir, "baseline.json");
  run([
    "audit",
    "--json",
    "--save-baseline",
    baseline,
    join(EXAMPLES, "guarded-repo"),
  ]);
  const r = run([
    "diff",
    "--json",
    "--baseline",
    baseline,
    join(EXAMPLES, "solo-repo"),
  ]);
  assert.equal(r.status, 1);
  const d = JSON.parse(r.stdout);
  assert.equal(d.regression, true);
  assert.ok(d.addedSolo.length >= 1);
});

test("e2e: init scaffolds a policy file and refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "pushpath-init-"));
  const first = run(["init", dir]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /created .*pushpath\.json/);
  const policy = JSON.parse(readFileSync(join(dir, "pushpath.json"), "utf8"));
  assert.equal(policy.version, 1);
  assert.equal(policy.requirePrReview, true);
  const second = run(["init", dir]);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already exists/);
});

test("e2e: explain lists rules and explains one with the 1Password anchor", () => {
  const list = run(["explain"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /solo-push/);
  assert.match(list.stdout, /1password/);
  const one = run(["explain", "solo-push"]);
  assert.equal(one.status, 0);
  assert.match(one.stdout, /One push reaches production/);
  assert.match(one.stdout, /1Password, 25\/11\/2026/);
  const incident = run(["explain", "1password"]);
  assert.equal(incident.status, 0);
  assert.match(incident.stdout, /19\/11\/2026/);
  assert.match(incident.stdout, /subset/);
  assert.match(incident.stdout, /NOT disclosed/);
  const bad = run(["explain", "no-such-rule"]);
  assert.equal(bad.status, 2);
});

test("e2e: bad input exits 2 with a clear message", () => {
  const missing = run(["audit", join(EXAMPLES, "does-not-exist")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /does not exist/);
  const noBaseline = run(["diff", join(EXAMPLES, "solo-repo")]);
  assert.equal(noBaseline.status, 2);
  assert.match(noBaseline.stderr, /requires --baseline/);
  const unknown = run(["frobnicate"]);
  assert.equal(unknown.status, 2);
});

test("e2e: audit on an empty directory is GUARDED, exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "pushpath-empty-"));
  writeFileSync(join(dir, "README.md"), "# nothing here\n");
  const r = run(["audit", dir]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no deploy path found/);
});
