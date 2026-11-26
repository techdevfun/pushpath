#!/usr/bin/env bash
# Capture the demo transcript from the REAL CLI (no hand-edited output).
# The real-repo step audits ossf/scorecard from inside its checkout
# (PUSHPATH_REAL_REPO, default /tmp/scorecard-clone) with a relative
# path, so the transcript never contains the builder's absolute paths.
# Runs from inside the scratch dir with relative paths elsewhere too.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH=/tmp/pushpath-demo
BIN="$SCRATCH/bin"
REAL_REPO="${PUSHPATH_REAL_REPO:-/tmp/scorecard-clone}"
rm -rf "$SCRATCH"
mkdir -p "$BIN" "$ROOT/demo"
ln -sf "$ROOT/dist/cli.js" "$BIN/pushpath"
chmod +x "$ROOT/dist/cli.js"
export PATH="$BIN:$PATH"

OUT="$ROOT/demo/transcript.txt"
BASELINE="$ROOT/examples/baseline.json"
cd "$ROOT"
{
  echo "# pushpath demo - real CLI output"
  echo "# (solo-repo is a synthetic fixture; the second audit runs on the"
  echo "#  REAL ossf/scorecard checkout, commit 789a810815a4398abf14b10898b111d3ced5d94d)"
  echo ""
  echo "$ pushpath init demo-policy"
  (cd "$SCRATCH" && pushpath init demo-policy)
  echo ""
  echo "$ pushpath audit examples/solo-repo"
  pushpath audit examples/solo-repo || echo "exit: $?"
  echo ""
  echo "# --- real repo: ossf/scorecard (17 workflows, tag-gated deploys) ---"
  echo "$ pushpath audit ."
  (cd "$REAL_REPO" && pushpath audit .) || echo "exit: $?"
  echo ""
  echo "$ pushpath check examples/solo-repo"
  pushpath check examples/solo-repo || echo "exit: $?"
  echo ""
  echo "$ pushpath audit --save-baseline examples/baseline.json examples/guarded-repo > /dev/null"
  pushpath audit --json --save-baseline "examples/baseline.json" examples/guarded-repo > /dev/null || echo "exit: $?"
  echo "(baseline written: guarded-repo audit, verdict GUARDED)"
  echo ""
  echo "$ pushpath diff --baseline examples/baseline.json examples/solo-repo"
  pushpath diff --baseline "examples/baseline.json" examples/solo-repo || echo "exit: $?"
  echo ""
  echo "$ pushpath explain solo-push"
  pushpath explain solo-push
} > "$OUT" 2>&1

echo "transcript written: $OUT ($(wc -l < "$OUT") lines)"
