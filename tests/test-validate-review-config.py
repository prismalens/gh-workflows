#!/usr/bin/env python3
"""Tests for the review configuration validator (tools/validate-review-config.py).

Verifies S0 schema enforcement:
- Valid configs pass with exit 0
- Unknown keys at top level or nested objects exit 1
- Invalid types, models, severities, or out-of-range numbers exit 1
- Empty files succeed with defaults (exit 0)
- Malformed YAML exits 1
"""
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "tools/validate-review-config.py"


VALID_CONFIG_FULL = """
version: 1

review:
  default_model: "claude-sonnet-5"
  auto_pause_rounds: 5
  skip_authors:
    - "dependabot[bot]"
  path_filters:
    - "!.changeset/**"
    - "!pnpm-lock.yaml"
  path_instructions:
    - path: "packages/*/src/**"
      instructions: "Update docs on CLI or config changes."
    - path: "packages/@prismalens/engine/src/**"
      instructions: "Engine is harness agnostic."

findings:
  suppress_below: "Major"
  enable_ai_fix_prompt: true
  include_verification_note: true
"""

VALID_CONFIG_MINIMAL = """
version: 1
"""

VALID_EMPTY_FILE = """
# Empty config with comments only
"""

UNKNOWN_TOP_LEVEL_KEY = """
version: 1
unknown_key: "not allowed"
"""

UNKNOWN_EXTENDS_KEY = """
version: 1
extends: "prismalens/.github"
"""

UNKNOWN_REVIEW_KEY = """
version: 1
review:
  model_name: "claude-sonnet-5"
"""

UNKNOWN_FINDINGS_KEY = """
version: 1
findings:
  severities:
    - "Critical"
    - "Major"
"""

INVALID_MODEL = """
version: 1
review:
  default_model: "gpt-4"
"""

INVALID_SUPPRESS_BELOW = """
version: 1
findings:
  suppress_below: "invalid_severity"
"""

INVALID_AUTO_PAUSE_ZERO = """
version: 1
review:
  auto_pause_rounds: 0
"""

INVALID_AUTO_PAUSE_STRING = """
version: 1
review:
  auto_pause_rounds: "five"
"""

INVALID_VERSION = """
version: 2
"""

MISSING_VERSION = """
review:
  default_model: "claude-sonnet-5"
"""

MALFORMED_YAML = """
version: 1
review:
  - invalid list structure for mapping
  path_filters: [
"""

INVALID_PATH_INSTRUCTION_MISSING_KEY = """
version: 1
review:
  path_instructions:
    - path: "src/**"
"""

INVALID_PATH_INSTRUCTION_UNKNOWN_KEY = """
version: 1
review:
  path_instructions:
    - path: "src/**"
      instructions: "Do stuff"
      extra_key: "disallowed"
"""


CASES = [
    ("valid full config", VALID_CONFIG_FULL, 0, None),
    ("valid minimal config", VALID_CONFIG_MINIMAL, 0, None),
    ("valid empty config (defaults apply)", VALID_EMPTY_FILE, 0, None),
    ("unknown top-level key rejected", UNKNOWN_TOP_LEVEL_KEY, 1, "Unknown configuration key 'unknown_key'"),
    ("stale extends key rejected", UNKNOWN_EXTENDS_KEY, 1, "Unknown configuration key 'extends'"),
    ("unknown review key rejected", UNKNOWN_REVIEW_KEY, 1, "Unknown configuration key 'review.model_name'"),
    ("stale findings.severities key rejected", UNKNOWN_FINDINGS_KEY, 1, "Unknown configuration key 'findings.severities'"),
    ("invalid model rejected", INVALID_MODEL, 1, "Invalid value for 'review.default_model'"),
    ("invalid suppress_below rejected", INVALID_SUPPRESS_BELOW, 1, "Invalid value for 'findings.suppress_below'"),
    ("auto_pause_rounds 0 rejected", INVALID_AUTO_PAUSE_ZERO, 1, "Invalid value for 'review.auto_pause_rounds'"),
    ("auto_pause_rounds string rejected", INVALID_AUTO_PAUSE_STRING, 1, "Invalid value for 'review.auto_pause_rounds'"),
    ("invalid version 2 rejected", INVALID_VERSION, 1, "Invalid value for 'version'"),
    ("missing required version rejected", MISSING_VERSION, 1, "Missing required key 'version'"),
    ("malformed YAML rejected", MALFORMED_YAML, 1, "Malformed YAML"),
    ("path_instructions missing instructions key rejected", INVALID_PATH_INSTRUCTION_MISSING_KEY, 1, "Missing or invalid required key 'instructions'"),
    ("path_instructions unknown key rejected", INVALID_PATH_INSTRUCTION_UNKNOWN_KEY, 1, "Unknown configuration key 'review.path_instructions[0].extra_key'"),
]


def run_test_case(name: str, content: str, want_code: int, want_err_substr: str | None) -> tuple[bool, str]:
    with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False) as tf:
        tf.write(content)
        temp_path = tf.name

    try:
        p = subprocess.run(
            [sys.executable, str(VALIDATOR), temp_path],
            capture_output=True,
            text=True,
        )
        if p.returncode != want_code:
            return False, f"exit code {p.returncode}, expected {want_code}. stderr: {p.stderr.strip()}"
        if want_err_substr and want_err_substr not in p.stderr:
            return False, f"expected error substring {want_err_substr!r} in stderr, got: {p.stderr.strip()}"
        return True, ""
    finally:
        pathlib.Path(temp_path).unlink(missing_ok=True)


def main() -> int:
    fails = []
    print(f"Running {len(CASES)} validator test cases against {VALIDATOR.name}\n")
    for name, content, want_code, want_err in CASES:
        ok, msg = run_test_case(name, content, want_code, want_err)
        status = "ok  " if ok else "FAIL"
        if not ok:
            fails.append(f"{name}: {msg}")
            print(f"  {status}  {name:<55} ({msg})")
        else:
            print(f"  {status}  {name:<55} (exit {want_code})")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        return 1

    print("All validator tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
