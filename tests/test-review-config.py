#!/usr/bin/env python3
"""Behavioural tests for per-repo configuration loading in `Read repository review configuration`.

Extracts the REAL shell body out of claude-code-review.yml and runs it against a
stubbed `gh`, verifying:
1. Absent config applies defaults and does not warn.
2. Malformed config warns, names the file and the base SHA, and applies defaults.
3. Valid config overrides default_model, auto_pause_rounds and skip_authors.
4. A valid config carrying an unconsumed key warns and names that key.

Run: python3 tests/test-review-config.py
"""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP = "Read repository review configuration"

BASE_SHA = "1234567890abcdef1234567890abcdef12345678"


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


GH_CONFIG_STUB = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"contents/.github/claude-review.yml"*)
    if [ "${FAKE_CONFIG_404:-0}" = "1" ]; then
      echo "gh stub: 404 Not Found" >&2
      exit 1
    fi
    printf '%s\n' "$FAKE_CONFIG_B64"
    exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_config_case(script, *, config_yaml=None, is_404=False,
                    input_default_model="claude-sonnet-5",
                    input_auto_pause_rounds="5",
                    input_skip_authors="dependabot[bot]",
                    base_sha=BASE_SHA):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_CONFIG_STUB)
        (binp / "gh").chmod(0o755)
        out_file = tdp / "output.txt"
        out_file.touch()

        fake_b64 = ""
        if config_yaml is not None:
            fake_b64 = base64.b64encode(config_yaml.encode("utf-8")).decode("ascii")

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            GH_TOKEN="x",
            REPO="prismalens/test-repo",
            BASE_SHA=base_sha,
            INPUT_DEFAULT_MODEL=str(input_default_model),
            INPUT_AUTO_PAUSE_ROUNDS=str(input_auto_pause_rounds),
            INPUT_SKIP_AUTHORS=str(input_skip_authors),
            FAKE_CONFIG_404="1" if is_404 else "0",
            FAKE_CONFIG_B64=fake_b64,
        )

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        return p.returncode, outputs, p.stdout, p.stderr


VALID_CONFIG_FULL = """
version: 1

review:
  default_model: "claude-opus-5"
  auto_pause_rounds: 10
  skip_authors:
    - "renovate[bot]"
    - "custom-bot"
  path_filters:
    - "packages/**"
"""

VALID_CONFIG_WITH_UNWIRED_KEYS = """
version: 1

review:
  default_model: "claude-opus-5"
  path_instructions:
    - path: "src/**"
      instructions: "Follow coding standards."

findings:
  suppress_below: "Major"
  enable_ai_fix_prompt: true
  include_verification_note: true
"""

MALFORMED_UNKNOWN_KEY = """
version: 1
unknown_key: "disallowed"
"""

MALFORMED_INVALID_MODEL = """
version: 1
review:
  default_model: "gpt-4"
"""

MALFORMED_YAML_SYNTAX = """
version: 1
review: [invalid
"""


def main():
    script = extract_step_script()
    fails = []

    def check(name, ok, detail=""):
        if ok:
            print(f"  ok    {name}")
        else:
            fails.append(f"{name}: {detail}")
            print(f"  FAIL  {name}: {detail}")

    print("=== Testing Review Config Loading (Part A) ===")

    # 1. Absent config (404) applies defaults and does not warn
    rc, out, stdout, stderr = run_config_case(script, is_404=True)
    check("absent config exits 0", rc == 0, f"rc={rc}")
    check("absent config applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("absent config applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
    check("absent config applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
    check("absent config produces no warning", "::warning::" not in stdout and "::warning::" not in stderr, f"stdout: {stdout}")
    check("absent config logs single info line", "No .github/claude-review.yml found" in stdout, f"stdout: {stdout}")

    # 2. Malformed config warns, names file and base SHA, and applies defaults
    for label, malformed_yaml, expected_err_sub in [
        ("unknown key", MALFORMED_UNKNOWN_KEY, "Unknown configuration key 'unknown_key'"),
        ("invalid model", MALFORMED_INVALID_MODEL, "Invalid value for 'review.default_model'"),
        ("yaml syntax error", MALFORMED_YAML_SYNTAX, "Malformed YAML"),
    ]:
        rc, out, stdout, stderr = run_config_case(script, config_yaml=malformed_yaml)
        check(f"malformed config ({label}) exits 0", rc == 0, f"rc={rc}")
        check(f"malformed config ({label}) applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
        check(f"malformed config ({label}) applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
        check(f"malformed config ({label}) applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
        has_warning = "::warning::" in stdout
        names_file = ".github/claude-review.yml" in stdout
        names_sha = BASE_SHA[:8] in stdout
        has_err = expected_err_sub in stdout
        check(f"malformed config ({label}) emits warning naming file, base SHA, and validator error",
              has_warning and names_file and names_sha and has_err,
              f"stdout={stdout!r}")

    # 3. Valid config overrides default_model, auto_pause_rounds, and skip_authors
    rc, out, stdout, stderr = run_config_case(script, config_yaml=VALID_CONFIG_FULL)
    check("valid config exits 0", rc == 0, f"rc={rc}")
    check("valid config overrides default_model to claude-opus-5", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    check("valid config overrides auto_pause_rounds to 10", out.get("auto_pause_rounds") == "10", f"got {out.get('auto_pause_rounds')}")
    check("valid config overrides skip_authors", out.get("skip_authors") == "renovate[bot],custom-bot", f"got {out.get('skip_authors')}")
    check("valid config logs consumed keys", "review.default_model=claude-opus-5" in stdout and "review.auto_pause_rounds=10" in stdout, f"stdout: {stdout}")
    check("valid config produces no warning", "::warning::" not in stdout, f"stdout: {stdout}")

    # 4. Valid config carrying unconsumed keys warns and names those keys
    rc, out, stdout, stderr = run_config_case(script, config_yaml=VALID_CONFIG_WITH_UNWIRED_KEYS)
    check("valid config with unwired keys exits 0", rc == 0, f"rc={rc}")
    check("valid config with unwired keys still consumes default_model", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    has_warning = "::warning::" in stdout
    warns_path_instructions = "review.path_instructions" in stdout
    warns_suppress_below = "findings.suppress_below" in stdout
    warns_ai_fix = "findings.enable_ai_fix_prompt" in stdout
    warns_verification = "findings.include_verification_note" in stdout
    check("valid config warns and names all unconsumed keys",
          has_warning and warns_path_instructions and warns_suppress_below and warns_ai_fix and warns_verification,
          f"stdout={stdout!r}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all config loading tests passed")


if __name__ == "__main__":
    main()
