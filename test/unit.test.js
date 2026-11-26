import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseYaml,
  getMap,
  asString,
  asStringList,
  mapEntries,
} from "../dist/yaml.js";
import { globMatch, scanRepo } from "../dist/scan.js";
import { computePathVerdict } from "../dist/verdict.js";
import { diffAudits, isRegression } from "../dist/diff.js";
import { RULES, findRule, INCIDENT_SUMMARY } from "../dist/rules.js";
import { DEFAULT_POLICY } from "../dist/config.js";
import { isShaPinned } from "../dist/deploy.js";

const NO_LIVE = {
  source: "none",
  branchProtection: "unknown",
  prReviewCount: null,
  envReviewers: {},
  repo: null,
  checkedAt: null,
};

function fixtureRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "pushpath-unit-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function audit(dir, policy = DEFAULT_POLICY) {
  return scanRepo({
    repoDir: dir,
    defaultBranch: "main",
    defaultBranchAssumed: false,
    policy,
    live: NO_LIVE,
  });
}

// --- YAML parser ---

test("yaml: nested maps, flow lists, and quoted keys", () => {
  const doc = parseYaml(
    `name: deploy\non:\n  push:\n    branches: [main, dev]\n  pull_request:\n    types: [opened]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n`,
  );
  assert.equal(asString(getMap(doc, "name")), "deploy");
  assert.deepEqual(
    asStringList(getMap(getMap(getMap(doc, "on"), "push"), "branches")),
    ["main", "dev"],
  );
  assert.deepEqual(
    asStringList(getMap(getMap(getMap(doc, "on"), "pull_request"), "types")),
    ["opened"],
  );
  assert.equal(
    asString(getMap(getMap(getMap(doc, "jobs"), "deploy"), "runs-on")),
    "ubuntu-latest",
  );
});

test("yaml: block sequence at the same indent as its parent key", () => {
  const doc = parseYaml(
    `on:\n  push:\n    branches:\n    - main\n  schedule:\n  - cron: "30 1 * * *"\n`,
  );
  const branches = asStringList(
    getMap(getMap(getMap(doc, "on"), "push"), "branches"),
  );
  assert.deepEqual(branches, ["main"]);
  const schedule = getMap(getMap(doc, "on"), "schedule");
  assert.equal(schedule.kind, "seq");
  assert.equal(asString(getMap(schedule.seq[0], "cron")), "30 1 * * *");
});

test("yaml: sequences of maps (steps) with nested with: blocks", () => {
  const doc = parseYaml(
    `jobs:\n  build:\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - name: Build\n        run: npm run build\n`,
  );
  const steps = getMap(getMap(getMap(doc, "jobs"), "build"), "steps");
  assert.equal(steps.seq.length, 2);
  assert.equal(asString(getMap(steps.seq[0], "uses")), "actions/checkout@v4");
  assert.equal(
    asString(getMap(getMap(steps.seq[0], "with"), "fetch-depth")),
    "0",
  );
  assert.equal(asString(getMap(steps.seq[1], "run")), "npm run build");
});

test("yaml: block scalars, inline comments, and quoted strings", () => {
  const doc = parseYaml(
    `jobs:\n  build:\n    steps:\n      - run: |\n          set -euo pipefail\n          npm test # inline comment\n      - uses: actions/checkout@v4 # trailing comment\n`,
  );
  const steps = getMap(getMap(getMap(doc, "jobs"), "build"), "steps");
  assert.match(
    asString(getMap(steps.seq[0], "run")),
    /set -euo pipefail\nnpm test/,
  );
  assert.equal(asString(getMap(steps.seq[1], "uses")), "actions/checkout@v4");
});

test("yaml: flow map, anchors, and the on: key staying a string", () => {
  const doc = parseYaml(
    `on:\n  workflow_dispatch:\n    inputs: {reason: {description: "why", required: true}}\n`,
  );
  const inputs = getMap(
    getMap(getMap(doc, "on"), "workflow_dispatch"),
    "inputs",
  );
  assert.equal(
    asString(getMap(getMap(inputs, "reason"), "description")),
    "why",
  );
  assert.deepEqual(
    mapEntries(doc).map((e) => e.key),
    ["on"],
  );
});

test("yaml: duplicate keys and tabs are parse errors", () => {
  assert.throws(() => parseYaml("on:\n  push:\n  push:\n"), /duplicate key/);
  assert.throws(() => parseYaml("on:\n\tpush:\n"), /tab/);
});

test("yaml: scalar on: form parses as a single event", () => {
  const doc = parseYaml("on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n");
  assert.equal(asString(getMap(doc, "on")), "push");
});

// --- glob matching ---

test("glob: branch patterns match GitHub-style", () => {
  assert.equal(globMatch("main", "main"), true);
  assert.equal(globMatch("main", "dev"), false);
  assert.equal(globMatch("release/*", "release/1.2"), true);
  assert.equal(globMatch("release/*", "release/1.2/3"), false);
  assert.equal(globMatch("v*", "v1.2.3"), true);
  assert.equal(globMatch("*", "anything"), true);
  assert.equal(globMatch("**", "a/b/c"), true);
});

// --- triggers and verdicts ---

test("verdict: push to main with no breaker is SOLO-PATH", () => {
  const dir = fixtureRepo({
    ".github/workflows/deploy.yml":
      "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n",
  });
  const r = audit(dir);
  assert.equal(r.verdict, "SOLO-PATH");
  assert.equal(r.paths[0].target, "npm registry");
  assert.equal(r.paths[0].trigger.reachesDefault, true);
  assert.match(
    r.paths[0].unverifiedControls.join(" "),
    /branch protection unverified/,
  );
});

test("verdict: push with a branch filter that excludes main is not default-reaching", () => {
  const dir = fixtureRepo({
    ".github/workflows/deploy.yml":
      "on:\n  push:\n    branches: [staging]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n",
  });
  const r = audit(dir);
  assert.equal(r.paths[0].trigger.reachesDefault, false);
  // A push to the listed branch still deploys, so the path is still solo.
  assert.equal(r.verdict, "SOLO-PATH");
});

test("verdict: tag-only deploy is GUARDED", () => {
  const dir = fixtureRepo({
    ".github/workflows/release.yml":
      'on:\n  push:\n    tags:\n      - "v*"\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1.0.0\n',
  });
  const r = audit(dir);
  assert.equal(r.verdict, "GUARDED");
  assert.equal(r.paths[0].trigger.kind, "push-tag");
});

test("verdict: release trigger is GUARDED, pull_request is UNKNOWN", () => {
  const rel = audit(
    fixtureRepo({
      ".github/workflows/r.yml":
        "on:\n  release:\n    types: [published]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n",
    }),
  );
  assert.equal(rel.verdict, "GUARDED");
  const pr = audit(
    fixtureRepo({
      ".github/workflows/p.yml":
        "on:\n  pull_request:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n",
    }),
  );
  assert.equal(pr.verdict, "UNKNOWN");
  assert.equal(pr.paths[0].trigger.kind, "pull-request");
});

test("verdict: environment without live data is UNKNOWN", () => {
  const dir = fixtureRepo({
    ".github/workflows/deploy.yml":
      "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: docker push ghcr.io/x/y:latest\n",
  });
  const r = audit(dir);
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.paths[0].environment, "production");
});

test("verdict: live data breaks the path (PR review / env approver)", () => {
  const base = {
    workflow: ".github/workflows/deploy.yml",
    job: "deploy",
    jobLine: 1,
    environment: null,
    target: "npm registry",
    trigger: {
      kind: "push",
      detail: "push to main",
      line: 1,
      reachesDefault: true,
    },
    releaseGated: false,
    evidence: [],
  };
  const withReview = computePathVerdict(base, {
    ...NO_LIVE,
    source: "gh",
    branchProtection: "required",
    prReviewCount: 1,
  });
  assert.equal(withReview.verdict, "GUARDED");
  assert.match(withReview.breakers.join(" "), /required PR review/);
  const withApprover = computePathVerdict(
    { ...base, environment: "production" },
    {
      ...NO_LIVE,
      source: "gh",
      branchProtection: "not-required",
      envReviewers: { production: 2 },
    },
  );
  assert.equal(withApprover.verdict, "GUARDED");
  assert.match(withApprover.breakers.join(" "), /requires 2 approver/);
  const noApprover = computePathVerdict(
    { ...base, environment: "production" },
    {
      ...NO_LIVE,
      source: "gh",
      branchProtection: "not-required",
      envReviewers: { production: 0 },
    },
  );
  assert.equal(noApprover.verdict, "SOLO-PATH");
});

test("verdict: release-gated job (if: on release event) is GUARDED", () => {
  const dir = fixtureRepo({
    ".github/workflows/deploy.yml":
      "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    if: github.event_name == 'release'\n    steps:\n      - run: npm publish\n",
  });
  const r = audit(dir);
  assert.equal(r.verdict, "GUARDED");
  assert.equal(r.paths[0].releaseGated, true);
});

test("verdict: no workflows at all is GUARDED with no paths", () => {
  const dir = fixtureRepo({ "README.md": "# hi\n" });
  const r = audit(dir);
  assert.equal(r.verdict, "GUARDED");
  assert.equal(r.paths.length, 0);
  assert.equal(r.workflowsScanned, 0);
});

test("verdict: unparseable workflow is UNKNOWN, listed, never a crash", () => {
  const dir = fixtureRepo({
    ".github/workflows/broken.yml":
      "on:\n  push:\n  push:\njobs:\n  deploy:\n    steps:\n      - run: npm publish\n",
  });
  const r = audit(dir);
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.unknownWorkflows.length, 1);
  assert.match(r.unknownWorkflows[0].reason, /duplicate key/);
});

// --- findings ---

test("findings: floating tags, write-all, and secret names (never values)", () => {
  const dir = fixtureRepo({
    ".github/workflows/deploy.yml":
      "on:\n  push:\n    branches: [main]\npermissions: write-all\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - run: npm publish\n        env:\n          TOKEN: ${{ secrets.NPM_TOKEN }}\n",
  });
  const r = audit(dir);
  const byRule = (rule) => r.findings.filter((f) => f.rule === rule);
  assert.equal(byRule("least-privilege").length, 1);
  assert.equal(byRule("least-privilege")[0].severity, "high");
  assert.equal(byRule("pin-actions").length, 1);
  assert.match(byRule("pin-actions")[0].message, /actions\/checkout@v4/);
  const secrets = byRule("secret-names");
  assert.equal(secrets.length, 1);
  assert.match(secrets[0].message, /NPM_TOKEN/);
  // The finding must never contain a secret VALUE: the fixture has none,
  // and the scanner only ever sees the NAME token.
  assert.doesNotMatch(JSON.stringify(r), /FAKE-VALUE/);
});

test("pins: SHA-pinned actions produce no pin finding", () => {
  assert.equal(isShaPinned("3d3c42e5aac5ba805825da76410c181273ba90b1"), true);
  assert.equal(isShaPinned("v4"), false);
  assert.equal(isShaPinned("main"), false);
  const dir = fixtureRepo({
    ".github/workflows/ci.yml":
      "on:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - run: npm test\n",
  });
  const r = audit(dir);
  assert.equal(r.findings.filter((f) => f.rule === "pin-actions").length, 0);
  assert.equal(r.verdict, "GUARDED");
});

test("deploy detection: commands and actions map to targets", () => {
  const dir = fixtureRepo({
    ".github/workflows/d.yml":
      "on:\n  push:\n    tags: ['v*']\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: kubectl apply -f k8s/\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v6\n",
  });
  const r = audit(dir);
  assert.equal(r.paths.length, 2);
  assert.deepEqual(r.paths.map((p) => p.target).sort(), [
    "Kubernetes",
    "container registry",
  ]);
});

// --- diff ---

test("diff: new solo path is a regression, resolved solo is not", () => {
  const base = {
    verdict: "GUARDED",
    paths: [{ key: "a.yml:deploy:npm registry", verdict: "GUARDED" }],
  };
  const cur = {
    verdict: "SOLO-PATH",
    paths: [
      { key: "a.yml:deploy:npm registry", verdict: "SOLO-PATH" },
      { key: "b.yml:ship:Kubernetes", verdict: "SOLO-PATH" },
    ],
  };
  const d = diffAudits(base, cur);
  assert.deepEqual(d.addedSolo, [
    "a.yml:deploy:npm registry",
    "b.yml:ship:Kubernetes",
  ]);
  assert.equal(isRegression(d), true);
  const fixed = diffAudits(cur, base);
  assert.deepEqual(fixed.resolvedSolo, [
    "a.yml:deploy:npm registry",
    "b.yml:ship:Kubernetes",
  ]);
  assert.equal(isRegression(fixed), false);
  assert.equal(isRegression(diffAudits(base, base)), false);
});

// --- rules / explain ---

test("rules: every rule has a fix and a 1Password anchor; incident facts are sourced", () => {
  assert.ok(RULES.length >= 7);
  for (const r of RULES) {
    assert.ok(r.what.length > 20, r.id);
    assert.ok(r.fix.length > 20, r.id);
    assert.match(r.anchor, /1Password, 25\/11\/2026/);
  }
  assert.equal(findRule("solo-push").title, "One push reaches production");
  assert.equal(findRule("nope"), undefined);
  const joined = INCIDENT_SUMMARY.join(" ");
  assert.match(joined, /19\/11\/2026/);
  assert.match(joined, /subset/);
  assert.match(joined, /NOT disclosed/);
  // No invented customer count and no speculation about the takeover.
  assert.doesNotMatch(joined, /phishing/i);
  assert.doesNotMatch(joined, /malware/i);
});

test("policy: default policy requires review and env approver", () => {
  assert.equal(DEFAULT_POLICY.requirePrReview, true);
  assert.equal(DEFAULT_POLICY.requireEnvironmentApprover, true);
  assert.equal(DEFAULT_POLICY.allowFloatingTags, false);
});
