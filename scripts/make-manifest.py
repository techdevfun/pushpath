#!/usr/bin/env python3
"""Build the batch manifest for the pushpath repo push.

Walks the build dir, excludes build output (node_modules, dist, .git),
and writes a manifest JSON with {entries: [{local_file, mode, path}]}
plus {"binary": true} for the demo GIF. Prints the file count and
the sha256 of every entry so the batch helper's tree verification
can be checked against it.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(
    os.path.dirname(ROOT), "pushpath-manifest-2026-11-26.json"
)
SKIP_DIRS = {"node_modules", "dist", ".git"}
BINARY_EXTS = {".gif", ".png", ".jpg", ".jpeg", ".zip", ".ico"}

entries = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, ROOT)
        entry = {
            "local_file": full,
            "mode": "100644",
            "path": rel.replace(os.sep, "/"),
        }
        if os.path.splitext(name)[1].lower() in BINARY_EXTS:
            entry["binary"] = True
        entries.append(entry)
        digest = hashlib.sha256(open(full, "rb").read()).hexdigest()
        print(f"{digest[:12]}  {rel}")

manifest = {"entries": entries}
with open(OUT, "w") as f:
    json.dump(manifest, f, indent=2)
print(f"\nmanifest: {OUT} ({len(entries)} entries)")
