"""Shared helper: extract a composite action's step script.

Not a `test-*.py` file, so `tests/test-*.py` globs (this repo's verify block,
tests.yml) never try to run it directly. #176 moved the review round telemetry
extraction out of claude-code-review.yml's inline steps and into
.github/actions/round-telemetry/action.yml, shared by the review and verify
jobs; every test that used to pull that step's `run:` out of the workflow now
comes here instead, in one place, rather than re-implementing the composite
action lookup per test.
"""
import pathlib
import sys

import yaml


def extract_composite_step_script(action_path: pathlib.Path, index: int = 0) -> str:
    action = yaml.safe_load(action_path.read_text())
    steps = (action.get("runs") or {}).get("steps") or []
    if index >= len(steps):
        sys.exit(f"composite action {action_path} has no step at index {index}")
    run = steps[index].get("run")
    if run is None:
        sys.exit(f"composite action {action_path} step [{index}] has no 'run' key")
    return run
