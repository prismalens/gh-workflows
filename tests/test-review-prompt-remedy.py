#!/usr/bin/env python3
"""Guards the review prompt's remedy, precedence and dedup rules (#151, tracked on #12).

Reads the prompt TEMPLATE out of the "build-prompt" step of claude-code-review.yml and
asserts each rule is present, then proves the check fails on a copy with each rule removed.

Run: python3 tests/test-review-prompt-remedy.py
"""
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"

# Each rule is one distinctive phrase; a reworded rule updates its phrase here.
RULES = {
    "remedy is a candidate": "Its fix is one candidate resolution from a reviewer that read part of the file, never an instruction",
    "agent block says candidate": "This is one candidate resolution. Verify the finding against current code",
    "cannot-tell remedy": "is current, then align the other\", never an edit to either passage",
    "say which passage is current": "say which passage you believe is current and on what evidence",
    "retired lines dropped": "Drop an issue anchored on a line the file itself retires",
    "live section re-anchor": "anchor it on the live section instead",
    "severity from whole fix": "Severity and Effort describe the whole fix the finding needs, not the anchored line",
    "one defect one comment": "Merge issues that a single edit resolves, including an issue that is the leftover of a partial repair of another",
    "two-file phrase not merged": "This does not merge the same phrase appearing in two changed files",
}
FORBIDDEN = {"imperative remedy": "<Imperative fix instruction>"}


def template(wf_text: str) -> str:
    wf = yaml.safe_load(wf_text)
    for step in wf["jobs"]["review"]["steps"]:
        if step.get("id") == "build-prompt":
            run = step["run"]
            start = run.index("<<'PROMPT_TEMPLATE_EOF'")
            end = run.index("\nPROMPT_TEMPLATE_EOF", start)
            return run[start:end]
    raise KeyError("build-prompt step not found")


def check(text: str) -> list[str]:
    fails = [f"missing rule '{k}': {v!r}" for k, v in RULES.items() if v not in text]
    fails += [f"forbidden '{k}' present: {v!r}" for k, v in FORBIDDEN.items() if v in text]
    return fails


def main():
    wf_text = WF.read_text(encoding="utf-8")
    fails = check(template(wf_text))
    for f in fails:
        print(f"  FAIL  real template: {f}")
    if not fails:
        print(f"  ok    real template carries {len(RULES)} rules and no imperative remedy")

    for name, phrase in {**RULES, **FORBIDDEN}.items():
        if name in FORBIDDEN:
            broken = wf_text.replace("<candidate fix>", phrase, 1)
        else:
            broken = wf_text.replace(phrase, "REMOVED", 1)
        got = check(template(broken))
        if not any(name in g for g in got):
            fails.append(f"negative '{name}': check still passed, got {got}")
            print(f"  FAIL  negative '{name}' not caught")
        else:
            print(f"  ok    negative '{name}' caught")

    if fails:
        print(f"\n{len(fails)} FAILED")
        sys.exit(1)
    print("\nall review prompt remedy checks passed")


if __name__ == "__main__":
    main()
