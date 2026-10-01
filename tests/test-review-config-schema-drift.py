#!/usr/bin/env python3
"""tools/review-config/schema.json accepts exactly what validate_config accepts.

The dashboard's config editor validates against the JSON Schema; the lane validates with the
Python in claude-code-review.yml, which stays the authority (#33). This runs the real
validate_config, cut out of the workflow, and the schema over one corpus and fails on any case
where they disagree.

Run: python3 tests/test-review-config-schema-drift.py (needs pyyaml and jsonschema)
"""
import json
import pathlib
import re
import sys
import textwrap

import jsonschema
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
SCHEMA = ROOT / "tools/review-config/schema.json"
CONFIG_STEP = "Read repository review configuration"


def load_validate_config():
    wf = yaml.safe_load(WF.read_text())
    run = next(
        step["run"]
        for job in wf["jobs"].values()
        for step in job.get("steps", []) or []
        if step.get("name") == CONFIG_STEP
    )
    py = run.split("<<'PY'\n", 1)[1].split("\nPY", 1)[0]
    py = textwrap.dedent(py)
    start = py.index("ALLOWED_TOP_LEVEL_KEYS")
    end = py.index("\n    return errors\n", py.index("def validate_config")) + len("\n    return errors\n")
    ns = {"re": re}
    exec(py[start:end], ns)
    return ns["validate_config"]


BASE = {"version": 1}


def with_review(**kv):
    return {"version": 1, "review": kv}


def with_findings(**kv):
    return {"version": 1, "findings": kv}


CORPUS = [
    BASE,
    {},
    {"version": 2},
    {"version": True},
    {"version": 1, "unknown": 1},
    {"version": 1, "extends": "prismalens/.github"},
    {"version": 1, "extends": "prismalens/.github@main"},
    {"version": 1, "extends": "nope"},
    {"version": 1, "extends": "prismalens/org-config"},
    {"version": 1, "extends": "prismalens/org-config@v1.2"},
    {"version": 1, "extends": "prismalens/org-config@a..b"},
    {"version": 1, "extends": "prismalens/org-config@/x"},
    {"version": 1, "extends": "prismalens/org-config@x/"},
    {"version": 1, "extends": "prismalens/org-config@"},
    {"version": 1, "extends": 7},
    {"version": 1, "review": []},
    with_review(default_model="claude-sonnet-5-5"),
    with_review(default_model="claude-opus-5"),
    with_review(default_model="claude-haiku-4-5"),
    with_review(level="medium"),
    with_review(level="low"),
    with_review(admission="label"),
    with_review(admission=False),
    with_review(admission="maybe"),
    with_review(auto_pause_rounds=3),
    with_review(auto_pause_rounds=0),
    with_review(auto_pause_rounds=True),
    with_review(skip_authors=["dependabot[bot]"]),
    with_review(skip_authors="dependabot[bot]"),
    with_review(escalation_paths=["worker/**"]),
    with_review(path_filters=["!docs/**", 3]),
    with_review(path_instructions=[{"path": "a/**", "instructions": "x"}]),
    with_review(path_instructions=[{"path": "a/**"}]),
    with_review(path_instructions=[{"path": "a", "instructions": "x", "extra": 1}]),
    with_review(max_reviewable_lines=0),
    with_review(max_reviewable_lines=-1),
    with_review(max_file_lines=500),
    with_review(language_map={"tsx": "TypeScript"}),
    with_review(language_map={".tsx": "TypeScript"}),
    with_review(language_map={"tsx": ""}),
    with_review(language_map={f"e{i}": "x" for i in range(65)}),
    with_review(tool_findings=["tsc", "eslint"]),
    with_review(tool_findings=["prettier"]),
    with_review(issue_context_byte_budget=2000),
    with_review(issue_context_total_byte_budget=-5),
    with_review(variant="exp-a.1"),
    with_review(variant="has space"),
    with_review(variant="x" * 65),
    with_review(context=[{"repository": "o/r", "ref": "main", "paths": ["docs/a.md"]}]),
    with_review(context=[{"repository": "o/r", "ref": "", "paths": ["a"]}]),
    with_review(context=[{"repository": "../..", "ref": "main", "paths": ["a"]}]),
    with_review(context=[{"repository": "o/.r", "ref": "main", "paths": ["a"]}]),
    with_review(context=[{"repository": "o/r", "ref": "main", "paths": ["../secret"]}]),
    with_review(context=[{"repository": "o/r", "ref": "main", "paths": ["/abs"]}]),
    with_review(context=[{"repository": "o/r", "ref": "main", "paths": []}]),
    with_review(context=[{"repository": "o/r", "ref": "main", "paths": ["a"]}] * 4),
    with_review(nope=1),
    with_findings(suppress_below="Major"),
    with_findings(suppress_below="major"),
    with_findings(enable_ai_fix_prompt=True),
    with_findings(include_verification_note="yes"),
    {"version": 1, "telemetry": {"share": "rounds"}},
    {"version": 1, "telemetry": {"share": False}},
    {"version": 1, "telemetry": {"share": "counts"}},
    {"version": 1, "telemetry": {"other": 1}},
]


def main():
    validate_config = load_validate_config()
    validator = jsonschema.Draft202012Validator(json.loads(SCHEMA.read_text()))
    fails = []
    for case in CORPUS:
        py_ok = not validate_config(case)
        schema_ok = validator.is_valid(case)
        if py_ok != schema_ok:
            fails.append(f"workflow {'accepts' if py_ok else 'rejects'}, schema {'accepts' if schema_ok else 'rejects'}: {json.dumps(case)[:160]}")
    print(f"  {len(CORPUS)} cases")
    if fails:
        print("FAIL")
        for f in fails:
            print("  " + f)
        sys.exit(1)
    print("PASS: schema.json and validate_config agree on every case")


if __name__ == "__main__":
    main()
