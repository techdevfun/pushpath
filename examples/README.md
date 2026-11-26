# Examples

All four repos under `examples/` are **synthetic fixtures**, written for
the test suite and the demo. They are not real projects.

- `solo-repo/` - push to `main` deploys straight to npm. No
  environment, no approver. Audit verdict: **SOLO-PATH**.
- `guarded-repo/` - deploys only when a `v*` tag is pushed, actions
  SHA-pinned. Audit verdict: **GUARDED**.
- `env-repo/` - push to `main` deploys behind a `production`
  environment. Whether an approver breaks the path is live data only.
  Audit verdict without `--live`: **UNKNOWN**.
- `weird-repo/` - a workflow file with invalid YAML (duplicate
  `push:` key). pushpath lists it as UNKNOWN, never crashes, never
  fails the audit for it.

`baseline.json` is the JSON output of a real `audit --json` run on
`solo-repo/` (produced by `scripts/capture-demo.sh`); `pushpath diff`
compares a fresh audit against it.

## Real-repo evidence

The demo also audits a real public repository: **ossf/scorecard**
(cloned 26/11/2026, commit `789a810815a4398abf14b10898b111d3ced5d94d`,
2026-11-23). Its deploy workflows (`goreleaser.yaml`,
`publishimage.yml`) are tag-gated (`push: tags: v*` / `*`) with
SHA-pinned actions, so the audit verdict is GUARDED. The clone is not
shipped in this repo; the live test re-clones it (soft-skips offline).
