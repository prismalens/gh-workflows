"""Every place that recognises a local round's finding by its trailing marker names exactly
the engines in runner/src/engines.js (#184). The marker is matched with endsWith, which takes
no wildcard, so an engine added to the registry must be added to each of these in the same change.

Run: python3 tests/test-assayer-marker-engines.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
registry = ROOT / "runner/src/engines.js"
start = registry.read_text().index("export const ENGINES")
engines = set(re.findall(r"^  '?([a-z0-9-]+)'?: \{", registry.read_text()[start:], re.M))
assert engines, "no engine rows found in runner/src/engines.js"

failed = False
for rel in [".github/workflows/claude-code-review.yml", ".github/workflows/claude.yml", "README.md"]:
    named = set(re.findall(r"endsWith\(github\.event\.comment\.body, '<!-- assayer-finding engine=([a-z0-9-]+) -->'\)", (ROOT / rel).read_text()))
    if named != engines:
        failed = True
        print(f"FAIL {rel}: names {sorted(named)}, registry has {sorted(engines)}")
    else:
        print(f"  ok    {rel} names every registry engine")
sys.exit(1 if failed else 0)
