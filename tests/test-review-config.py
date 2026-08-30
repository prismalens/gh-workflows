#!/usr/bin/env python3
"""Behavioural tests for per-repo review config loading and model escalation.

Extracts the REAL shell bodies out of claude-code-review.yml and runs them against a
stubbed `gh`, verifying:
1. Absent config applies defaults and does not warn.
2. Malformed config warns, names the file and the base SHA, and applies defaults.
3. Valid config overrides default_model, auto_pause_rounds and skip_authors.
4. A valid config carrying an unconsumed key warns and names that key.
5. A changed file matching path_filters escalates to opus.
6. A changed file not matching leaves the default model.
7. A summon `--model` override beats a path match (precedence rule).

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
CONFIG_STEP = "Read repository review configuration"
MODEL_STEP = "Resolve review model"

BASE_SHA = "1234567890abcdef1234567890abcdef12345678"


def extract_step_script(step_name: str) -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == step_name:
                return step["run"]
    sys.exit(f"step {step_name!r} not found in {WF}")


GH_STUB = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"contents/.github/claude-review.yml"*)
    if [ "${FAKE_CONFIG_404:-0}" = "1" ]; then
      echo "gh stub: 404 Not Found" >&2
      exit 1
    fi
    printf '%s\n' "$FAKE_CONFIG_B64"
    exit 0 ;;
  *"pulls/"*"/files"*)
    if [ "${FAKE_FILES_FAIL:-0}" = "1" ]; then
      echo "gh stub: 500 Internal Server Error" >&2
      exit 1
    fi
    if [ -n "${FAKE_FILES_JSON:-}" ]; then
      if [[ "$args" == *"--jq"* ]]; then
        echo "$FAKE_FILES_JSON" | jq -r '.[].filename'
      else
        echo "$FAKE_FILES_JSON"
      fi
    else
      echo "[]"
    fi
    exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_config_case(script, *, config_yaml=None, is_404=False,
                    input_default_model="claude-sonnet-5",
                    input_auto_pause_rounds="5",
                    input_skip_authors="dependabot[bot]",
                    base_sha=BASE_SHA,
                    no_pyyaml=False):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        out_file = tdp / "output.txt"
        out_file.touch()

        fake_b64 = ""
        if config_yaml is not None:
            fake_b64 = base64.b64encode(config_yaml.encode("utf-8")).decode("ascii")

        env = dict(os.environ)
        pythonpath = env.get("PYTHONPATH", "")
        if no_pyyaml:
            fake_pkg = tdp / "fake_pkg"
            fake_pkg.mkdir()
            (fake_pkg / "yaml.py").write_text("raise ImportError(\"No module named 'yaml'\")\n")
            pythonpath = f"{fake_pkg}:{pythonpath}"

        env.update(
            PATH=f"{binp}:{env['PATH']}",
            PYTHONPATH=pythonpath,
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


def run_model_case(script, *, body="", aliases="opus=claude-opus-5,sonnet=claude-sonnet-5",
                   default_model="claude-sonnet-5", path_filters=None,
                   changed_files=None, repo="prismalens/test-repo", pr="42",
                   files_fail=False):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        out_file = tdp / "output.txt"
        out_file.touch()

        files_json = ""
        if changed_files is not None:
            files_json = json.dumps([{"filename": f} for f in changed_files])

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            GH_TOKEN="x",
            REPO=repo,
            PR=str(pr),
            BODY=body,
            ALIASES=aliases,
            DEFAULT_MODEL=default_model,
            PATH_FILTERS=json.dumps(path_filters if path_filters is not None else []),
            FAKE_FILES_JSON=files_json,
            FAKE_FILES_FAIL="1" if files_fail else "0",
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
    config_script = extract_step_script(CONFIG_STEP)
    model_script = extract_step_script(MODEL_STEP)
    fails = []

    def check(name, ok, detail=""):
        if ok:
            print(f"  ok    {name}")
        else:
            fails.append(f"{name}: {detail}")
            print(f"  FAIL  {name}: {detail}")

    print("=== Testing Review Config Loading (Part A: #33) ===")

    # 1. Absent config (404) applies defaults and does not warn
    rc, out, stdout, stderr = run_config_case(config_script, is_404=True)
    check("absent config exits 0", rc == 0, f"rc={rc}")
    check("absent config applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("absent config applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
    check("absent config applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
    check("absent config applies empty path_filters", json.loads(out.get("path_filters", "null")) == [], f"got {out.get('path_filters')}")
    check("absent config produces no warning", "::warning::" not in stdout and "::warning::" not in stderr, f"stdout: {stdout}")
    check("absent config logs single info line", "No .github/claude-review.yml found" in stdout, f"stdout: {stdout}")

    # 2. Malformed config warns, names file and base SHA, and applies defaults
    for label, malformed_yaml, expected_err_sub in [
        ("unknown key", MALFORMED_UNKNOWN_KEY, "Unknown configuration key 'unknown_key'"),
        ("invalid model", MALFORMED_INVALID_MODEL, "Invalid value for 'review.default_model'"),
        ("yaml syntax error", MALFORMED_YAML_SYNTAX, "Malformed YAML"),
    ]:
        rc, out, stdout, stderr = run_config_case(config_script, config_yaml=malformed_yaml)
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
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_FULL)
    check("valid config exits 0", rc == 0, f"rc={rc}")
    check("valid config overrides default_model to claude-opus-5", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    check("valid config overrides auto_pause_rounds to 10", out.get("auto_pause_rounds") == "10", f"got {out.get('auto_pause_rounds')}")
    check("valid config overrides skip_authors", out.get("skip_authors") == "renovate[bot],custom-bot", f"got {out.get('skip_authors')}")
    check("valid config sets path_filters", json.loads(out.get("path_filters", "[]")) == ["packages/**"], f"got {out.get('path_filters')}")
    check("valid config logs consumed keys", "review.default_model=claude-opus-5" in stdout and "review.auto_pause_rounds=10" in stdout, f"stdout: {stdout}")
    check("valid config produces no warning", "::warning::" not in stdout, f"stdout: {stdout}")

    # 4. Valid config carrying unconsumed keys warns and names those keys
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_WITH_UNWIRED_KEYS)
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

    # 4b. Missing PyYAML warns and falls back rather than failing the step
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_FULL, no_pyyaml=True)
    check("missing pyyaml exits 0", rc == 0, f"rc={rc}")
    check("missing pyyaml applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("missing pyyaml applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
    check("missing pyyaml applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
    check("missing pyyaml emits warning naming PyYAML", "::warning::" in stdout and "PyYAML" in stdout, f"stdout={stdout!r}")

    print("\n=== Testing Model Escalation (Part B: #34) ===")

    # 5. A changed file matching path_filters escalates to opus
    rc, out, stdout, stderr = run_model_case(
        model_script,
        path_filters=["packages/@prismalens/engine/**", "src/auth.ts"],
        changed_files=["packages/@prismalens/engine/src/core.ts", "docs/readme.md"],
    )
    check("path match escalates to opus", rc == 0 and out.get("model") == "claude-opus-5", f"model={out.get('model')}")
    check("path match reports model_source=escalated by path match", out.get("model_source") == "escalated by path match", f"source={out.get('model_source')}")

    # 5b. Trailing /** matches directory recursively
    rc, out, stdout, stderr = run_model_case(
        model_script,
        path_filters=["packages/engine/**"],
        changed_files=["packages/engine/a/b/c.py"],
    )
    check("trailing /** matches deep nested path", rc == 0 and out.get("model") == "claude-opus-5", f"model={out.get('model')}")

    # 6. A changed file not matching leaves default model
    rc, out, stdout, stderr = run_model_case(
        model_script,
        path_filters=["packages/@prismalens/engine/**"],
        changed_files=["docs/readme.md", "packages/ui/button.tsx"],
    )
    check("non-matching files leave default model", rc == 0 and out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("non-matching files report model_source=default", out.get("model_source") == "default", f"source={out.get('model_source')}")

    # 7. A summon `--model` override beats a path match (precedence rule)
    rc, out, stdout, stderr = run_model_case(
        model_script,
        body="@claude review --model sonnet",
        path_filters=["packages/@prismalens/engine/**"],
        changed_files=["packages/@prismalens/engine/src/core.ts"],
    )
    check("summon --model override beats path match", rc == 0 and out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("summon override reports model_source=summon override", out.get("model_source") == "summon override", f"source={out.get('model_source')}")

    # 7b. Summon --model opus on non-matching files selects opus
    rc, out, stdout, stderr = run_model_case(
        model_script,
        body="@claude full review --model opus",
        path_filters=["packages/@prismalens/engine/**"],
        changed_files=["docs/readme.md"],
    )
    check("summon --model opus selects opus", rc == 0 and out.get("model") == "claude-opus-5", f"model={out.get('model')}")
    check("summon --model opus reports model_source=summon override", out.get("model_source") == "summon override", f"source={out.get('model_source')}")

    # 8. Changed-files fetch failure warns, uses default model, and sets model_source
    rc, out, stdout, stderr = run_model_case(
        model_script,
        path_filters=["packages/@prismalens/engine/**"],
        files_fail=True,
    )
    check("changed-files fetch failure exits 0", rc == 0, f"rc={rc}")
    check("changed-files fetch failure uses default model", out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("changed-files fetch failure reports model_source=default (changed-files fetch failed)", out.get("model_source") == "default (changed-files fetch failed)", f"source={out.get('model_source')}")
    check("changed-files fetch failure emits warning naming command and stderr", "::warning::" in stdout and "repos/prismalens/test-repo/pulls/42/files" in stdout and "500 Internal Server Error" in stdout, f"stdout={stdout!r}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all config loading and model escalation tests passed")


if __name__ == "__main__":
    main()
