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
8. config_effective (#75) carries a {value, layer} entry per resolved key, layer matching
   whichever of workflow/org/repo actually supplied it, with no hardcoded key list.

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
PATH_INSTRUCTIONS_STEP = "Resolve path instructions"

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
if [ -n "${GH_CALL_LOG:-}" ]; then
  echo "$args" >> "$GH_CALL_LOG"
fi
case "$args" in
  *"repos/${EXPECTED_ORG_REPO}/contents/.github/claude-review-defaults.yml?ref=${EXPECTED_ORG_REF}"*)
    if [ "${FAKE_ORG_CONFIG_404:-0}" = "1" ]; then
      echo "gh stub: 404 Not Found" >&2
      exit 1
    fi
    if [ "${FAKE_ORG_CONFIG_FAIL:-0}" = "1" ]; then
      echo "gh stub: 500 Internal Server Error" >&2
      exit 1
    fi
    printf '%s\n' "$FAKE_ORG_CONFIG_B64"
    exit 0 ;;
  *"contents/.github/claude-review.yml?ref=${EXPECTED_BASE_SHA}"*)
    if [ "${FAKE_CONFIG_404:-0}" = "1" ]; then
      echo "gh stub: 404 Not Found" >&2
      exit 1
    fi
    if [ "${FAKE_CONFIG_FAIL:-0}" = "1" ]; then
      echo "gh stub: 500 Internal Server Error" >&2
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


def run_config_case(script, *, org_config_yaml=None, org_is_404=True, org_fail=False,
                    config_yaml=None, is_404=False, config_fail=False,
                    input_default_model="claude-sonnet-5",
                    input_auto_pause_rounds="5",
                    input_skip_authors="dependabot[bot]",
                    base_sha=BASE_SHA,
                    workflow_ref="prismalens/prismalens/.github/workflows/claude-code-review.yml@refs/pull/514/merge",
                    no_pyyaml=False,
                    expected_base_sha=None,
                    expected_org_repo=None,
                    expected_org_ref=None):
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

        fake_org_b64 = ""
        if org_config_yaml is not None:
            fake_org_b64 = base64.b64encode(org_config_yaml.encode("utf-8")).decode("ascii")
            org_is_404 = False

        if org_fail:
            org_is_404 = False

        if config_fail:
            is_404 = False

        if expected_base_sha is None:
            expected_base_sha = base_sha

        if expected_org_repo is None:
            expected_org_repo = "prismalens/gh-workflows"

        if expected_org_ref is None:
            expected_org_ref = "main"

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
            WORKFLOW_REF=workflow_ref,
            EXPECTED_BASE_SHA=expected_base_sha,
            EXPECTED_ORG_REPO=expected_org_repo,
            EXPECTED_ORG_REF=expected_org_ref,
            INPUT_DEFAULT_MODEL=str(input_default_model),
            INPUT_AUTO_PAUSE_ROUNDS=str(input_auto_pause_rounds),
            INPUT_SKIP_AUTHORS=str(input_skip_authors),
            FAKE_ORG_CONFIG_404="1" if org_is_404 else "0",
            FAKE_ORG_CONFIG_FAIL="1" if org_fail else "0",
            FAKE_ORG_CONFIG_B64=fake_org_b64,
            FAKE_CONFIG_404="1" if is_404 else "0",
            FAKE_CONFIG_FAIL="1" if config_fail else "0",
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
                   default_model="claude-sonnet-5", escalation_paths=None, path_filters=None,
                   changed_files=None, repo="prismalens/test-repo", pr="42",
                   files_fail=False, config_level="medium"):
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

        effective_esc = escalation_paths if escalation_paths is not None else (path_filters if path_filters is not None else [])
        effective_pf = path_filters if path_filters is not None else []

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
            ESCALATION_PATHS=json.dumps(effective_esc),
            PATH_FILTERS=json.dumps(effective_pf),
            FAKE_FILES_JSON=files_json,
            FAKE_FILES_FAIL="1" if files_fail else "0",
            CONFIG_LEVEL=config_level,
        )

        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        return p.returncode, outputs, p.stdout, p.stderr


def run_path_instructions_case(script, *, path_instructions=None, mode="review",
                               changed_files=None, incremental_range_files=None,
                               repo="prismalens/test-repo", pr="42",
                               files_fail=False):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        out_file = tdp / "output.txt"
        out_file.touch()
        call_log = tdp / "gh_calls.txt"

        files_json = ""
        if changed_files is not None:
            files_json = json.dumps([{"filename": f} for f in changed_files])

        if mode == "incremental" and incremental_range_files is not None:
            range_data = {"files": [{"filename": f} for f in incremental_range_files]}
            (tdp / ".claude-incremental-range.json").write_text(json.dumps(range_data), encoding="utf-8")

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_WORKSPACE=str(tdp),
            GITHUB_OUTPUT=str(out_file),
            GH_CALL_LOG=str(call_log),
            GH_TOKEN="x",
            REPO=repo,
            PR=str(pr),
            MODE=mode,
            PATH_INSTRUCTIONS=json.dumps(path_instructions) if path_instructions is not None else "[]",
            FAKE_FILES_FAIL="1" if files_fail else "0",
            FAKE_FILES_JSON=files_json,
        )

        p = subprocess.run(["bash", "-c", script], env=env, cwd=str(tdp),
                           capture_output=True, text=True)
        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        file_content = None
        target_file = tdp / ".claude-path-instructions.md"
        if target_file.exists():
            file_content = target_file.read_text(encoding="utf-8")

        gh_calls = call_log.read_text().splitlines() if call_log.exists() else []

        return p.returncode, outputs, p.stdout, p.stderr, file_content, gh_calls


VALID_CONFIG_FULL = """
version: 1

review:
  default_model: "claude-opus-5"
  auto_pause_rounds: 10
  skip_authors:
    - "renovate[bot]"
    - "custom-bot"
  escalation_paths:
    - "packages/**"
  path_filters:
    - "dist/**"
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

# #101 ruling: 'low' is schema-rejected for this release, not merely an arbitrary
# invalid string — this fixture proves that specific, deliberate rejection.
MALFORMED_LEVEL_LOW = """
version: 1
review:
  level: "low"
"""

VALID_CONFIG_LEVEL_HIGH = """
version: 1

review:
  level: "high"
"""

MALFORMED_YAML_SYNTAX = """
version: 1
review: [invalid
"""

MALFORMED_PATH_INSTRUCTIONS = """
version: 1
review:
  path_instructions: "not-a-list"
"""

ORG_CONFIG_FULL = """
version: 1

review:
  default_model: "claude-opus-5"
  auto_pause_rounds: 8
  skip_authors:
    - "org-bot"
  path_filters:
    - "org-core/**"
"""

ORG_CONFIG_LEVEL_HIGH = """
version: 1

review:
  level: "high"
"""

REPO_CONFIG_PARTIAL = """
version: 1

review:
  default_model: "claude-sonnet-5"
  auto_pause_rounds: 3
"""

ORG_WITH_PATH_INSTRUCTIONS = """
version: 1

review:
  path_instructions:
    - path: "org-src/**"
      instructions: "Org instruction for org-src."
"""

REPO_WITH_PATH_INSTRUCTIONS = """
version: 1

review:
  path_instructions:
    - path: "repo-src/**"
      instructions: "Repo instruction for repo-src."
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

    print("=== Testing Review Config Loading (Part A: #33, #54) ===")

    # 1. Org defaults absent and repo config absent: workflow defaults apply
    rc, out, stdout, stderr = run_config_case(config_script, org_is_404=True, is_404=True)
    check("org absent and repo absent: exits 0", rc == 0, f"rc={rc}")
    check("org absent and repo absent: applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("org absent and repo absent: applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
    check("org absent and repo absent: applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
    check("org absent and repo absent: applies empty path_filters", json.loads(out.get("path_filters", "null")) == [], f"got {out.get('path_filters')}")
    check("org absent and repo absent: produces no warning", "::warning::" not in stdout and "::warning::" not in stderr, f"stdout: {stdout}")
    check("org absent and repo absent: logs workflow default sources", "review.default_model: claude-sonnet-5 (source: workflow default)" in stdout, f"stdout: {stdout}")
    check("org absent and repo absent: applies level default of medium (#101)", out.get("level") == "medium", f"got {out.get('level')}")
    check("org absent and repo absent: logs level workflow default source", "review.level: medium (source: workflow default)" in stdout, f"stdout: {stdout}")

    # 2. Org defaults present, repo config absent: org values apply
    rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=ORG_CONFIG_FULL, is_404=True)
    check("org present and repo absent: exits 0", rc == 0, f"rc={rc}")
    check("org present and repo absent: applies org default_model", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    check("org present and repo absent: applies org auto_pause_rounds", out.get("auto_pause_rounds") == "8", f"got {out.get('auto_pause_rounds')}")
    check("org present and repo absent: applies org skip_authors", out.get("skip_authors") == "org-bot", f"got {out.get('skip_authors')}")
    check("org present and repo absent: applies org path_filters", json.loads(out.get("path_filters", "[]")) == ["org-core/**"], f"got {out.get('path_filters')}")
    check("org present and repo absent: logs org defaults source", "review.default_model: claude-opus-5 (source: org defaults)" in stdout, f"stdout: {stdout}")
    check("org present and repo absent: produces no warning", "::warning::" not in stdout, f"stdout: {stdout}")

    # 2b. review.level (#101): org layer accepts 'high' the same way as any other key.
    rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=ORG_CONFIG_LEVEL_HIGH, is_404=True)
    check("level: org defaults exits 0", rc == 0, f"rc={rc}")
    check("level: org defaults sets level to high", out.get("level") == "high", f"got {out.get('level')}")
    check("level: org defaults logs its source", "review.level: high (source: org defaults)" in stdout, f"stdout: {stdout}")

    # 3. Both present: repo wins key by key, and a key set only in org defaults still applies
    rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=ORG_CONFIG_FULL, config_yaml=REPO_CONFIG_PARTIAL)
    check("both present: exits 0", rc == 0, f"rc={rc}")
    check("both present: repo overrides default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("both present: repo overrides auto_pause_rounds", out.get("auto_pause_rounds") == "3", f"got {out.get('auto_pause_rounds')}")
    check("both present: org skip_authors inherited", out.get("skip_authors") == "org-bot", f"got {out.get('skip_authors')}")
    check("both present: org path_filters inherited", json.loads(out.get("path_filters", "[]")) == ["org-core/**"], f"got {out.get('path_filters')}")
    check("both present: logs per-key sources accurately",
          "review.default_model: claude-sonnet-5 (source: repo config)" in stdout and
          "review.auto_pause_rounds: 3 (source: repo config)" in stdout and
          "review.skip_authors: org-bot (source: org defaults)" in stdout and
          "review.path_filters: ['org-core/**'] (source: org defaults)" in stdout,
          f"stdout: {stdout}")

    # 3b. config_effective (#75): one {value, layer} entry per key config_hash hashes,
    # a layer per source actually resolved (repo/org/workflow all exercised at once here),
    # and no hardcoded key list — a new resolved_config key needs no change to this step.
    config_effective = json.loads(out.get("config_effective", "{}"))
    check("config_effective is a non-empty object", isinstance(config_effective, dict) and config_effective, f"got {config_effective!r}")
    check("config_effective repo-sourced default_model carries layer=repo",
          config_effective.get("default_model") == {"value": "claude-sonnet-5", "layer": "repo"},
          f"got {config_effective.get('default_model')!r}")
    check("config_effective repo-sourced auto_pause_rounds carries layer=repo and an int value",
          config_effective.get("auto_pause_rounds") == {"value": 3, "layer": "repo"},
          f"got {config_effective.get('auto_pause_rounds')!r}")
    check("config_effective org-sourced skip_authors carries layer=org",
          config_effective.get("skip_authors") == {"value": "org-bot", "layer": "org"},
          f"got {config_effective.get('skip_authors')!r}")
    check("config_effective org-sourced path_filters carries layer=org",
          config_effective.get("path_filters") == {"value": ["org-core/**"], "layer": "org"},
          f"got {config_effective.get('path_filters')!r}")
    check("config_effective unset max_reviewable_lines carries layer=workflow (not 'unavailable')",
          config_effective.get("max_reviewable_lines") == {"value": 6000, "layer": "workflow"},
          f"got {config_effective.get('max_reviewable_lines')!r}")
    check("config_effective carries every key config_hash hashes, no more and no less",
          set(config_effective.keys()) == {
              "default_model", "auto_pause_rounds", "skip_authors", "escalation_paths",
              "path_filters", "path_instructions", "max_reviewable_lines", "max_file_lines",
              "language_map", "tool_findings", "issue_context_byte_budget",
              "issue_context_total_byte_budget", "level",
          },
          f"got keys {sorted(config_effective.keys())}")
    check("config_effective excludes variant, same as config_hash", "variant" not in config_effective, f"got keys {sorted(config_effective.keys())}")

    # 4. Malformed org defaults: warns, ignored, workflow defaults apply, and run continues
    for label, malformed_yaml, expected_err_sub in [
        ("unknown key", MALFORMED_UNKNOWN_KEY, "Unknown configuration key 'unknown_key'"),
        ("invalid model", MALFORMED_INVALID_MODEL, "Invalid value for 'review.default_model'"),
        ("level low, schema-rejected this release (#101)", MALFORMED_LEVEL_LOW, "Invalid value for 'review.level'"),
        ("yaml syntax error", MALFORMED_YAML_SYNTAX, "Malformed YAML"),
    ]:
        rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=malformed_yaml, is_404=True)
        check(f"malformed org config ({label}) exits 0", rc == 0, f"rc={rc}")
        check(f"malformed org config ({label}) applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
        check(f"malformed org config ({label}) applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
        check(f"malformed org config ({label}) applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
        has_warning = "::warning::" in stdout
        names_file = ".github/claude-review-defaults.yml" in stdout
        names_ref = "main" in stdout
        has_err = expected_err_sub in stdout
        check(f"malformed org config ({label}) emits warning naming file, ref, and validator error",
              has_warning and names_file and names_ref and has_err,
              f"stdout={stdout!r}")

    # Repo config tests (absent, malformed, valid, unwired)
    rc, out, stdout, stderr = run_config_case(config_script, is_404=True)
    check("absent config exits 0", rc == 0, f"rc={rc}")
    check("absent config applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("absent config applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
    check("absent config applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
    check("absent config applies empty path_filters", json.loads(out.get("path_filters", "null")) == [], f"got {out.get('path_filters')}")
    check("absent config produces no warning", "::warning::" not in stdout and "::warning::" not in stderr, f"stdout: {stdout}")
    check("absent config logs single info line", "No .github/claude-review.yml found" in stdout, f"stdout: {stdout}")

    for label, malformed_yaml, expected_err_sub in [
        ("unknown key", MALFORMED_UNKNOWN_KEY, "Unknown configuration key 'unknown_key'"),
        ("invalid model", MALFORMED_INVALID_MODEL, "Invalid value for 'review.default_model'"),
        ("level low, schema-rejected this release (#101)", MALFORMED_LEVEL_LOW, "Invalid value for 'review.level'"),
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

    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_FULL)
    check("valid config exits 0", rc == 0, f"rc={rc}")
    check("valid config overrides default_model to claude-opus-5", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    check("valid config overrides auto_pause_rounds to 10", out.get("auto_pause_rounds") == "10", f"got {out.get('auto_pause_rounds')}")
    check("valid config overrides skip_authors", out.get("skip_authors") == "renovate[bot],custom-bot", f"got {out.get('skip_authors')}")
    check("valid config sets escalation_paths", json.loads(out.get("escalation_paths", "[]")) == ["packages/**"], f"got {out.get('escalation_paths')}")
    check("valid config sets path_filters", json.loads(out.get("path_filters", "[]")) == ["dist/**"], f"got {out.get('path_filters')}")
    check("valid config logs consumed keys", "review.default_model=claude-opus-5" in stdout and "review.auto_pause_rounds=10" in stdout, f"stdout: {stdout}")
    check("valid config produces no warning", "::warning::" not in stdout, f"stdout: {stdout}")

    # 3c. review.level (#101): repo config accepts 'high' through the same base-not-head
    # path as every other key (schema, repo layer, resolved_config, step outputs).
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_LEVEL_HIGH)
    check("level: repo config exits 0", rc == 0, f"rc={rc}")
    check("level: repo config sets level to high", out.get("level") == "high", f"got {out.get('level')}")
    check("level: repo config logs its source", "review.level: high (source: repo config)" in stdout, f"stdout: {stdout}")
    check("level: repo config produces no warning", "::warning::" not in stdout, f"stdout: {stdout}")

    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_WITH_UNWIRED_KEYS)
    check("valid config with unwired keys exits 0", rc == 0, f"rc={rc}")
    check("valid config with unwired keys still consumes default_model", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    warning_lines = [l for l in stdout.splitlines() if "::warning::" in l]
    warning_text = "\n".join(warning_lines)
    has_warning = len(warning_lines) > 0
    warns_path_instructions = "review.path_instructions" in warning_text
    warns_suppress_below = "findings.suppress_below" in warning_text
    warns_ai_fix = "findings.enable_ai_fix_prompt" in warning_text
    warns_verification = "findings.include_verification_note" in warning_text
    check("valid config warns and names unconsumed keys (losing path_instructions)",
          has_warning and (not warns_path_instructions) and warns_suppress_below and warns_ai_fix and warns_verification,
          f"stdout={stdout!r}")

    # 4b. Missing PyYAML warns and falls back rather than failing the step
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_FULL, no_pyyaml=True)
    check("missing pyyaml exits 0", rc == 0, f"rc={rc}")
    check("missing pyyaml applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("missing pyyaml applies auto_pause_rounds", out.get("auto_pause_rounds") == "5", f"got {out.get('auto_pause_rounds')}")
    check("missing pyyaml applies skip_authors", out.get("skip_authors") == "dependabot[bot]", f"got {out.get('skip_authors')}")
    check("missing pyyaml emits warning naming PyYAML", "::warning::" in stdout and "PyYAML" in stdout, f"stdout={stdout!r}")

    # 4c. Base-ref invariant: repository config fetched strictly with supplied BASE_SHA
    custom_base_sha = "abcdef0123456789abcdef0123456789abcdef01"
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=VALID_CONFIG_FULL, base_sha=custom_base_sha)
    check("base-ref invariant: repo config fetched at supplied BASE_SHA exits 0", rc == 0, f"rc={rc}")
    check("base-ref invariant: repo config fetched at supplied BASE_SHA applies config", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    check("base-ref invariant: repo config produces no warning", "::warning::" not in stdout, f"stdout={stdout}")

    # 4d. Org defaults target invariant: fetched strictly from prismalens/gh-workflows at main unconditionally
    rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=ORG_CONFIG_FULL, is_404=True,
                                              expected_org_repo="prismalens/gh-workflows", expected_org_ref="main")
    check("org defaults target invariant: fetched from prismalens/gh-workflows@main exits 0", rc == 0, f"rc={rc}")
    check("org defaults target invariant: applies org config", out.get("default_model") == "claude-opus-5", f"got {out.get('default_model')}")
    check("org defaults target invariant: produces no warning", "::warning::" not in stdout, f"stdout={stdout}")

    # 4e. Org defaults fetch failure (non-404): emits warning, applies defaults, does not report file absent
    rc, out, stdout, stderr = run_config_case(config_script, org_fail=True, is_404=False)
    check("org config fetch failure (non-404) exits 0", rc == 0, f"rc={rc}")
    check("org config fetch failure (non-404) applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("org config fetch failure (non-404) emits warning naming file, ref, and failure",
          "::warning::" in stdout and ".github/claude-review-defaults.yml" in stdout and "main" in stdout and "500 Internal Server Error" in stdout,
          f"stdout={stdout!r}")
    check("org config fetch failure (non-404) does not report absence", "No .github/claude-review-defaults.yml found" not in stdout, f"stdout={stdout!r}")

    # 4f. Repo config fetch failure (non-404): emits warning, applies defaults, does not report file absent
    rc, out, stdout, stderr = run_config_case(config_script, config_fail=True, is_404=False)
    check("repo config fetch failure (non-404) exits 0", rc == 0, f"rc={rc}")
    check("repo config fetch failure (non-404) applies default_model", out.get("default_model") == "claude-sonnet-5", f"got {out.get('default_model')}")
    check("repo config fetch failure (non-404) emits warning naming file, base ref, and failure",
          "::warning::" in stdout and ".github/claude-review.yml" in stdout and BASE_SHA[:8] in stdout and "500 Internal Server Error" in stdout,
          f"stdout={stdout!r}")
    check("repo config fetch failure (non-404) does not report absence", "No .github/claude-review.yml found" not in stdout, f"stdout={stdout!r}")

    # 4g. Whitespace in skip_authors is stripped cleanly
    rc, out, stdout, stderr = run_config_case(config_script, input_skip_authors=" dependabot[bot] , renovate[bot] , custom-bot ", is_404=True)
    check("skip_authors input with whitespace is stripped", out.get("skip_authors") == "dependabot[bot],renovate[bot],custom-bot", f"got {out.get('skip_authors')}")

    print("\n=== Testing Model Escalation (Part B: #34) ===")

    # 5. A changed file matching escalation_paths escalates to opus
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**", "src/auth.ts"],
        changed_files=["packages/@prismalens/engine/src/core.ts", "docs/readme.md"],
    )
    check("path match escalates to opus", rc == 0 and out.get("model") == "claude-opus-5", f"model={out.get('model')}")
    check("path match reports model_source=escalated by path match", out.get("model_source") == "escalated by path match", f"source={out.get('model_source')}")

    # 5b. Trailing /** matches directory recursively
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/engine/**"],
        changed_files=["packages/engine/a/b/c.py"],
    )
    check("trailing /** matches deep nested path", rc == 0 and out.get("model") == "claude-opus-5", f"model={out.get('model')}")

    # 5c. path_filters without escalation_paths does NOT escalate to opus (#140, finding 3944010345)
    rc, out, stdout, stderr = run_model_case(
        model_script,
        path_filters=["package-lock.json"],
        escalation_paths=[],
        changed_files=["package-lock.json"],
    )
    check("path_filters alone does not escalate to opus", rc == 0 and out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")

    # 6. A changed file not matching leaves default model
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["docs/readme.md", "packages/ui/button.tsx"],
    )
    check("non-matching files leave default model", rc == 0 and out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("non-matching files report model_source=default", out.get("model_source") == "default", f"source={out.get('model_source')}")

    # 7. A summon `--model` override beats a path match (precedence rule)
    rc, out, stdout, stderr = run_model_case(
        model_script,
        body="@claude review --model sonnet",
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["packages/@prismalens/engine/src/core.ts"],
    )
    check("summon --model override beats path match", rc == 0 and out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("summon override reports model_source=summon override", out.get("model_source") == "summon override", f"source={out.get('model_source')}")

    # 7b. Summon --model opus on non-matching files selects opus
    rc, out, stdout, stderr = run_model_case(
        model_script,
        body="@claude full review --model opus",
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["docs/readme.md"],
    )
    check("summon --model opus selects opus", rc == 0 and out.get("model") == "claude-opus-5", f"model={out.get('model')}")
    check("summon --model opus reports model_source=summon override", out.get("model_source") == "summon override", f"source={out.get('model_source')}")

    # 8. Changed-files fetch failure warns, uses default model, and sets model_source
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**"],
        files_fail=True,
    )
    check("changed-files fetch failure exits 0", rc == 0, f"rc={rc}")
    check("changed-files fetch failure uses default model", out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("changed-files fetch failure reports model_source=default (changed-files fetch failed)", out.get("model_source") == "default (changed-files fetch failed)", f"source={out.get('model_source')}")
    check("changed-files fetch failure emits warning naming command and stderr", "::warning::" in stdout and "repos/prismalens/test-repo/pulls/42/files" in stdout and "500 Internal Server Error" in stdout, f"stdout={stdout!r}")

    print("\n=== Testing review.level escalation floor (#101 ruling) ===")

    # 9. No path match: level passes through unchanged, level_source=config
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["docs/readme.md"],
        config_level="medium",
    )
    check("no path match: level unchanged", rc == 0 and out.get("level") == "medium", f"level={out.get('level')}")
    check("no path match: level_source=config", out.get("level_source") == "config", f"source={out.get('level_source')}")

    # 10. Path match with level already medium: floor is a no-op on the value, but the
    # source still says escalation happened (mirrors model_source's own behavior).
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["packages/@prismalens/engine/src/core.ts"],
        config_level="medium",
    )
    check("path match at medium: level stays medium", rc == 0 and out.get("level") == "medium", f"level={out.get('level')}")
    check("path match at medium: level_source=escalation", out.get("level_source") == "escalation", f"source={out.get('level_source')}")

    # 11. Path match with level already high: the floor never lowers it (never a ceiling).
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["packages/@prismalens/engine/src/core.ts"],
        config_level="high",
    )
    check("path match at high: level stays high (floor, never a ceiling)", rc == 0 and out.get("level") == "high", f"level={out.get('level')}")
    check("path match at high: level_source=escalation", out.get("level_source") == "escalation", f"source={out.get('level_source')}")

    # 12. The floor applies regardless of a --model summon: level and model are
    # orthogonal, so a model override must not also suppress the level floor.
    rc, out, stdout, stderr = run_model_case(
        model_script,
        body="@claude review --model sonnet",
        escalation_paths=["packages/@prismalens/engine/**"],
        changed_files=["packages/@prismalens/engine/src/core.ts"],
        config_level="medium",
    )
    check("model summon does not gate the level floor: model honors summon", rc == 0 and out.get("model") == "claude-sonnet-5", f"model={out.get('model')}")
    check("model summon does not gate the level floor: level still escalates", out.get("level") == "medium" and out.get("level_source") == "escalation", f"level={out.get('level')} source={out.get('level_source')}")

    # 13. A changed-files fetch failure degrades the level floor the same way it
    # degrades model escalation: fall back to the configured value, do not guess.
    rc, out, stdout, stderr = run_model_case(
        model_script,
        escalation_paths=["packages/@prismalens/engine/**"],
        files_fail=True,
        config_level="medium",
    )
    check("fetch failure: level falls back to configured value", rc == 0 and out.get("level") == "medium", f"level={out.get('level')}")
    check("fetch failure: level_source=config (floor not applied blind)", out.get("level_source") == "config", f"source={out.get('level_source')}")

    print("\n=== Testing Path Instructions Configuration (#120) ===")

    # 9. Org-then-repo ordering: org entries concatenate first, repo entries second, tagged with source
    rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=ORG_WITH_PATH_INSTRUCTIONS, config_yaml=REPO_WITH_PATH_INSTRUCTIONS)
    check("org-then-repo ordering exits 0", rc == 0, f"rc={rc}")
    instructions = json.loads(out.get("path_instructions", "[]"))
    check("org-then-repo ordering has 2 entries", len(instructions) == 2, f"got {instructions}")
    check("org-then-repo ordering: org entry first", len(instructions) == 2 and instructions[0]["path"] == "org-src/**" and instructions[0]["source"] == "org defaults", f"got {instructions}")
    check("org-then-repo ordering: repo entry second", len(instructions) == 2 and instructions[1]["path"] == "repo-src/**" and instructions[1]["source"] == "repo config", f"got {instructions}")

    # 10. Each layer alone
    # 10a. Org layer alone
    rc, out, stdout, stderr = run_config_case(config_script, org_config_yaml=ORG_WITH_PATH_INSTRUCTIONS, is_404=True)
    org_alone = json.loads(out.get("path_instructions", "[]"))
    check("org layer alone exits 0", rc == 0, f"rc={rc}")
    check("org layer alone carries org entries with org source", len(org_alone) == 1 and org_alone[0]["path"] == "org-src/**" and org_alone[0]["source"] == "org defaults", f"got {org_alone}")

    # 10b. Repo layer alone
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=REPO_WITH_PATH_INSTRUCTIONS, org_is_404=True)
    repo_alone = json.loads(out.get("path_instructions", "[]"))
    check("repo layer alone exits 0", rc == 0, f"rc={rc}")
    check("repo layer alone carries repo entries with repo source", len(repo_alone) == 1 and repo_alone[0]["path"] == "repo-src/**" and repo_alone[0]["source"] == "repo config", f"got {repo_alone}")

    # 10c. Failure path: malformed path_instructions in repo config
    rc, out, stdout, stderr = run_config_case(config_script, config_yaml=MALFORMED_PATH_INSTRUCTIONS)
    check("malformed path_instructions exits 0 and falls back to workflow defaults", rc == 0 and json.loads(out.get("path_instructions", "null")) == [], f"got {out.get('path_instructions')}")
    check("malformed path_instructions emits warning naming validator error", "::warning::" in stdout and "review.path_instructions" in stdout and "expected list of mappings" in stdout, f"stdout={stdout!r}")

    print("\n=== Testing Path Instructions Resolution (#120) ===")
    path_instructions_script = extract_step_script(PATH_INSTRUCTIONS_STEP)

    sample_instructions = [
        {"path": "packages/@prismalens/engine/**", "instructions": "Audit engine invariants strictly.", "source": "org defaults"},
        {"path": "docs/**", "instructions": "Ensure doc formatting matches style guide.", "source": "repo config"},
    ]

    # 11. Matched entry appearing in file with the other absent
    rc, out, stdout, stderr, content, calls = run_path_instructions_case(
        path_instructions_script,
        path_instructions=sample_instructions,
        changed_files=["packages/@prismalens/engine/src/index.ts", "README.md"],
    )
    check("matched entry exits 0", rc == 0, f"rc={rc}")
    check("matched entry sets matched=true", out.get("matched") == "true", f"out={out}")
    check("matched entry writes file", content is not None, "file was not written")
    check("matched entry appears in file", content is not None and "Audit engine invariants strictly." in content and "Path: `packages/@prismalens/engine/**`" in content and "source: `org defaults`" in content, f"content={content}")
    check("unmatched entry is absent from file", content is not None and "Ensure doc formatting matches style guide." not in content and "docs/**" not in content, f"content={content}")

    # 12. No match log line
    rc, out, stdout, stderr, content, calls = run_path_instructions_case(
        path_instructions_script,
        path_instructions=sample_instructions,
        changed_files=["src/unknown.ts"],
    )
    check("no match exits 0", rc == 0, f"rc={rc}")
    check("no match sets matched=false", out.get("matched") == "false", f"out={out}")
    check("no match produces no file", content is None, f"content={content}")
    check("no match log line printed", "path_instructions: 2 configured, 0 matched across 1 changed file(s)" in stdout, f"stdout={stdout}")

    # 13. Empty list makes no gh call
    rc, out, stdout, stderr, content, calls = run_path_instructions_case(
        path_instructions_script,
        path_instructions=[],
        changed_files=["packages/@prismalens/engine/src/index.ts"],
    )
    check("empty list exits 0", rc == 0, f"rc={rc}")
    check("empty list sets matched=false", out.get("matched") == "false", f"out={out}")
    check("empty list produces no file", content is None, f"content={content}")
    check("no gh call when list is empty", len(calls) == 0, f"calls={calls}")

    # 14. Incremental mode matches against range file
    rc, out, stdout, stderr, content, calls = run_path_instructions_case(
        path_instructions_script,
        path_instructions=sample_instructions,
        mode="incremental",
        incremental_range_files=["packages/@prismalens/engine/src/core.ts"],
    )
    check("incremental mode exits 0", rc == 0, f"rc={rc}")
    check("incremental mode sets matched=true", out.get("matched") == "true", f"out={out}")
    check("incremental mode matches against range file", content is not None and "Audit engine invariants strictly." in content, f"content={content}")
    check("incremental mode makes no gh files call", len(calls) == 0, f"calls={calls}")

    # 15. Changed-files fetch failure warns and continues without a file
    rc, out, stdout, stderr, content, calls = run_path_instructions_case(
        path_instructions_script,
        path_instructions=sample_instructions,
        files_fail=True,
    )
    check("fetch failure exits 0", rc == 0, f"rc={rc}")
    check("fetch failure sets matched=false", out.get("matched") == "false", f"out={out}")
    check("fetch failure produces no file", content is None, f"content={content}")
    check("fetch failure emits warning", "::warning::" in stdout and "500 Internal Server Error" in stdout, f"stdout={stdout}")

    # 16. Incremental mode with missing range file warns and continues without file
    rc, out, stdout, stderr, content, calls = run_path_instructions_case(
        path_instructions_script,
        path_instructions=sample_instructions,
        mode="incremental",
        incremental_range_files=None,
    )
    check("missing range file exits 0", rc == 0, f"rc={rc}")
    check("missing range file sets matched=false", out.get("matched") == "false", f"out={out}")
    check("missing range file produces no file", content is None, f"content={content}")
    check("missing range file emits warning", "::warning::" in stdout and "Incremental range file not found" in stdout, f"stdout={stdout}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all config loading, model escalation, and path instructions tests passed")


if __name__ == "__main__":
    main()
