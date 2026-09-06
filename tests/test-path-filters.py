#!/usr/bin/env python3
"""Behavioural tests for default path filters, override semantics, and telemetry metrics (#105).

Extracts the REAL shell body of 'Filter review paths' and 'Extract review round telemetry'
out of claude-code-review.yml and runs them against fixtures, verifying:
1. Default filters exclude lockfiles and generated files while leaving source alone.
2. Repo-set review.path_filters replaces defaults rather than merging with them.
3. diff_lines and diff_lines_raw differ when files are excluded, and match when none are.
4. changed_files and changed_files_raw differ when files are excluded, and match when none are.
5. The filter step logs pattern and exclusion counts, including the no-exclusion line.
6. Incremental range files are updated in-place to drop excluded files.
7. Telemetry extraction records both filtered and raw counts in the payload.

Run: python3 tests/test-path-filters.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
FILTER_STEP = "Filter review paths"
TELEMETRY_STEP = "Extract review round telemetry"


def cleanup_tmp():
    for name in ["incremental-range.json", "claude-path-filters-result.json"]:
        p = pathlib.Path(f"/tmp/{name}")
        if p.exists():
            try:
                p.unlink()
            except Exception:
                pass


def extract_step_script(step_name: str) -> str:
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == step_name:
                return step["run"]
    sys.exit(f"step {step_name!r} not found in {WF}")


def run_filter_step(script, *,
                    files=None,
                    mode="review",
                    path_filters=None,
                    config_resolution=None,
                    resolve_cf="",
                    resolve_dl="",
                    gh_files_json=None,
                    gh_fail=False,
                    gh_malformed=False):
    cleanup_tmp()
    try:
        with tempfile.TemporaryDirectory() as td:
            tdp = pathlib.Path(td)
            binp = tdp / "bin"
            binp.mkdir()

            # Stub gh api if needed
            gh_stub = binp / "gh"
            if gh_malformed:
                files_payload = "not-valid-json{"
            elif gh_files_json is not None:
                if gh_files_json and isinstance(gh_files_json[0], list):
                    files_payload = json.dumps(gh_files_json)
                else:
                    files_payload = json.dumps([gh_files_json])
            else:
                files_payload = "[]"

            gh_stub.write_text(f"""#!/usr/bin/env bash
args="$*"
if [ "${{FAKE_GH_FAIL:-0}}" = "1" ]; then
  echo "gh: API rate limit exceeded" >&2
  exit 1
fi
case "$args" in
  *"pulls/"*"/files"*)
    printf '%s\\n' '{files_payload}'
    exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
""")
            gh_stub.chmod(0o755)

            out_file = tdp / "output.txt"
            out_file.touch()

            # Incremental range file setup
            if mode == "incremental" and files is not None:
                range_data = {"files": files}
                inc_file = tdp / ".claude-incremental-range.json"
                inc_file.write_text(json.dumps(range_data), encoding="utf-8")
                tmp_range = pathlib.Path("/tmp/incremental-range.json")
                tmp_range.write_text(json.dumps(range_data), encoding="utf-8")

            env = dict(os.environ)
            env.update(
                PATH=f"{binp}:{env.get('PATH', '')}",
                GITHUB_OUTPUT=str(out_file),
                GITHUB_WORKSPACE=str(tdp),
                MODE=mode,
                REPO="test-org/test-repo",
                PR="105",
                RESOLVE_CHANGED_FILES=str(resolve_cf),
                RESOLVE_DIFF_LINES=str(resolve_dl),
                FAKE_GH_FAIL="1" if gh_fail else "0",
            )
            if path_filters is not None:
                env["PATH_FILTERS"] = json.dumps(path_filters) if isinstance(path_filters, list) else str(path_filters)
            else:
                env["PATH_FILTERS"] = "[]"

            if config_resolution is not None:
                env["CONFIG_RESOLUTION"] = json.dumps(config_resolution) if isinstance(config_resolution, dict) else str(config_resolution)
            else:
                env["CONFIG_RESOLUTION"] = "{}"

            res_path = pathlib.Path("/tmp/claude-path-filters-result.json")
            cwd = str(tdp)
            p = subprocess.run(["bash", "-c", script], env=env, cwd=cwd,
                               capture_output=True, text=True)

            result_json = None
            if res_path.exists():
                try:
                    result_json = json.loads(res_path.read_text(encoding="utf-8"))
                except Exception as e:
                    result_json = f"MALFORMED_JSON: {e}"

            outputs = {}
            if out_file.exists():
                for line in out_file.read_text().splitlines():
                    if "=" in line:
                        k, v = line.split("=", 1)
                        outputs[k] = v

            range_files_after = None
            if mode == "incremental":
                inc_file = tdp / ".claude-incremental-range.json"
                if inc_file.exists():
                    try:
                        range_files_after = json.loads(inc_file.read_text())["files"]
                    except Exception:
                        pass

            return p.returncode, outputs, result_json, p.stdout, range_files_after
    finally:
        cleanup_tmp()


def run_telemetry_step(script, *,
                       execution_file_content,
                       path_filters_result=None,
                       resolve_cf="5",
                       resolve_dl="500"):
    cleanup_tmp()
    try:
        with tempfile.TemporaryDirectory() as td:
            tdp = pathlib.Path(td)
            exec_file = tdp / "execution.json"
            exec_file.write_text(execution_file_content, encoding="utf-8")
            out_file = tdp / "output.txt"
            out_file.touch()

            res_path = pathlib.Path("/tmp/claude-path-filters-result.json")
            if path_filters_result is not None:
                res_path.write_text(json.dumps(path_filters_result), encoding="utf-8")

            env = dict(os.environ)
            env.update(
                EXECUTION_FILE=str(exec_file),
                GITHUB_OUTPUT=str(out_file),
                REPO="test-org/test-repo",
                PR_NUMBER="105",
                SERVER_URL="https://github.com",
                RUN_ID="12345",
                RUN_ATTEMPT="1",
                ROUND_TYPE="review",
                MODEL="claude-sonnet-5",
                RESOLVE_CHANGED_FILES=str(resolve_cf),
                RESOLVE_DIFF_LINES=str(resolve_dl),
                CLAUDE_OUTCOME="success",
                HEAD_SHA="abcdef1234567890abcdef1234567890abcdef12",
                PROMPT_HASH="hash123",
                ACTION_VERSION="v1",
                CONFIG_HASH="conf123",
                VARIANT="",
                AGENTS="[]",
                AGENTS_STATUS="",
            )

            p = subprocess.run(["bash", "-c", script], env=env,
                               capture_output=True, text=True)

            record = None
            if out_file.exists():
                text = out_file.read_text()
                if "record<<TELEMETRY_EOF" in text:
                    rec_str = text.split("record<<TELEMETRY_EOF\n")[1].split("\nTELEMETRY_EOF")[0]
                    try:
                        record = json.loads(rec_str)
                    except Exception:
                        pass

            return p.returncode, record, p.stdout + p.stderr
    finally:
        cleanup_tmp()


def main():
    filter_script = extract_step_script(FILTER_STEP)
    telemetry_script = extract_step_script(TELEMETRY_STEP)
    fails = []

    print(f"=== Testing {FILTER_STEP} & {TELEMETRY_STEP} ===\n")

    # -------------------------------------------------------------
    # 1. Default filters exclude lockfiles and leave source alone
    # -------------------------------------------------------------
    pr_files = [
        {"filename": "package-lock.json", "additions": 57000, "deletions": 10},
        {"filename": "src/index.ts", "additions": 25, "deletions": 5},
    ]
    rc, outs, res, stdout, _ = run_filter_step(
        filter_script,
        gh_files_json=pr_files,
        resolve_cf="2",
        resolve_dl="57040",
    )
    if rc != 0:
        fails.append(f"case 1 failed with rc={rc}")
    elif not res:
        fails.append("case 1: no path filters result written")
    else:
        if res.get("changed_files") != 1:
            fails.append(f"case 1: want changed_files=1, got {res.get('changed_files')}")
        if res.get("diff_lines") != 30:
            fails.append(f"case 1: want diff_lines=30, got {res.get('diff_lines')}")
        if res.get("changed_files_raw") != 2:
            fails.append(f"case 1: want changed_files_raw=2, got {res.get('changed_files_raw')}")
        if res.get("diff_lines_raw") != 57040:
            fails.append(f"case 1: want diff_lines_raw=57040, got {res.get('diff_lines_raw')}")
        if res.get("excluded_count") != 1:
            fails.append(f"case 1: want excluded_count=1, got {res.get('excluded_count')}")
        if "path_filters: 13 patterns, 1 of 2 changed file(s) excluded" not in stdout:
            fails.append(f"case 1: expected log line not in stdout: {stdout!r}")
        print("  ok    default filters exclude lockfile (package-lock.json) and leave source (src/index.ts)")

    # -------------------------------------------------------------
    # 2. Repo-set path_filters replaces defaults rather than merging
    # -------------------------------------------------------------
    repo_cfg_res = {"sources": {"path_filters": "repo config"}}
    custom_files = [
        {"filename": "package-lock.json", "additions": 100, "deletions": 0},
        {"filename": "dist/bundle.js", "additions": 50, "deletions": 0},
        {"filename": "src/main.ts", "additions": 10, "deletions": 2},
    ]
    rc, outs, res, stdout, _ = run_filter_step(
        filter_script,
        path_filters=["dist/**"],
        config_resolution=repo_cfg_res,
        gh_files_json=custom_files,
    )
    if rc != 0:
        fails.append(f"case 2 failed with rc={rc}")
    elif not res:
        fails.append("case 2: no result written")
    else:
        if res.get("changed_files") != 2:
            fails.append(f"case 2: want changed_files=2, got {res.get('changed_files')}")
        if res.get("diff_lines") != 112:
            fails.append(f"case 2: want diff_lines=112, got {res.get('diff_lines')}")
        if res.get("excluded_count") != 1:
            fails.append(f"case 2: want excluded_count=1, got {res.get('excluded_count')}")
        if "path_filters: 1 patterns, 1 of 3 changed file(s) excluded" not in stdout:
            fails.append(f"case 2: expected log line not in stdout: {stdout!r}")
        print("  ok    repo-set path_filters replaces defaults rather than merging")

    # -------------------------------------------------------------
    # 3. diff_lines and diff_lines_raw differ when excluded, match when none excluded
    # -------------------------------------------------------------
    clean_files = [
        {"filename": "src/app.ts", "additions": 20, "deletions": 5},
        {"filename": "README.md", "additions": 3, "deletions": 1},
    ]
    rc, outs, res, stdout, _ = run_filter_step(
        filter_script,
        gh_files_json=clean_files,
    )
    if rc != 0:
        fails.append(f"case 3 failed with rc={rc}")
    elif not res:
        fails.append("case 3: no result written")
    else:
        if res.get("diff_lines") != res.get("diff_lines_raw"):
            fails.append(f"case 3: diff_lines ({res.get('diff_lines')}) != diff_lines_raw ({res.get('diff_lines_raw')})")
        if res.get("changed_files") != res.get("changed_files_raw"):
            fails.append(f"case 3: changed_files ({res.get('changed_files')}) != changed_files_raw ({res.get('changed_files_raw')})")
        if res.get("diff_lines") != 29:
            fails.append(f"case 3: want diff_lines=29, got {res.get('diff_lines')}")
        print("  ok    diff_lines and diff_lines_raw match when nothing is excluded")

    # -------------------------------------------------------------
    # 4. The no-exclusion log line
    # -------------------------------------------------------------
    expected_no_excl_log = "path_filters: 13 patterns, 0 of 2 changed file(s) excluded"
    if expected_no_excl_log not in stdout:
        fails.append(f"case 4: expected log line {expected_no_excl_log!r} not in stdout: {stdout!r}")
    else:
        print(f"  ok    no-exclusion log line logged: {expected_no_excl_log}")

    # -------------------------------------------------------------
    # 5. Incremental mode updates range file in-place
    # -------------------------------------------------------------
    inc_files = [
        {"filename": "Cargo.lock", "additions": 1000, "deletions": 500},
        {"filename": "src/lib.rs", "additions": 40, "deletions": 10},
    ]
    rc, outs, res, stdout, range_after = run_filter_step(
        filter_script,
        mode="incremental",
        files=inc_files,
    )
    if rc != 0:
        fails.append(f"case 5 failed with rc={rc}")
    elif range_after is None:
        fails.append("case 5: incremental range file was not updated")
    else:
        filenames_after = [f["filename"] for f in range_after]
        if filenames_after != ["src/lib.rs"]:
            fails.append(f"case 5: expected ['src/lib.rs'] in range file, got {filenames_after}")
        if res.get("diff_lines") != 50:
            fails.append(f"case 5: want diff_lines=50, got {res.get('diff_lines')}")
        if res.get("diff_lines_raw") != 1550:
            fails.append(f"case 5: want diff_lines_raw=1550, got {res.get('diff_lines_raw')}")
        print("  ok    incremental mode updates range file in-place, removing lockfile")

    # -------------------------------------------------------------
    # 6. Telemetry integration: record carries changed_files_raw and diff_lines_raw
    # -------------------------------------------------------------
    exec_content = json.dumps([
        {"type": "result", "session_id": "sess-filter-test", "total_cost_usd": 0.12,
         "duration_ms": 15000, "num_turns": 6, "permission_denials": 0,
         "modelUsage": {"claude-sonnet-5": {"inputTokens": 200, "outputTokens": 50}}}
    ])
    pf_res = {
        "changed_files": 2,
        "diff_lines": 45,
        "changed_files_raw": 5,
        "diff_lines_raw": 68651,
        "excluded_count": 3,
        "pattern_count": 13,
    }
    rc, record, out = run_telemetry_step(
        telemetry_script,
        execution_file_content=exec_content,
        path_filters_result=pf_res,
        resolve_cf="5",
        resolve_dl="68651",
    )
    if rc != 0:
        fails.append(f"case 6: telemetry step exited {rc}: {out}")
    elif not isinstance(record, dict):
        fails.append(f"case 6: telemetry record is not dict: {record}")
    else:
        if record.get("changed_files") != 2:
            fails.append(f"case 6: want changed_files=2, got {record.get('changed_files')}")
        if record.get("diff_lines") != 45:
            fails.append(f"case 6: want diff_lines=45, got {record.get('diff_lines')}")
        if record.get("changed_files_raw") != 5:
            fails.append(f"case 6: want changed_files_raw=5, got {record.get('changed_files_raw')}")
        if record.get("diff_lines_raw") != 68651:
            fails.append(f"case 6: want diff_lines_raw=68651, got {record.get('diff_lines_raw')}")
        print("  ok    telemetry payload carries both filtered and raw counts (diff_lines_raw, changed_files_raw)")

    # -------------------------------------------------------------
    # 7. Multi-page PR is slurped and aggregated across pages (#140, finding 3944010346)
    # -------------------------------------------------------------
    page1 = [
        {"filename": "package-lock.json", "additions": 100, "deletions": 0},
    ]
    page2 = [
        {"filename": "src/main.ts", "additions": 20, "deletions": 5},
    ]
    rc, outs, res, stdout, _ = run_filter_step(
        filter_script,
        gh_files_json=[page1, page2],
    )
    if rc != 0:
        fails.append(f"case 7: multi-page slurp failed with rc={rc}")
    elif not res:
        fails.append("case 7: no result written")
    else:
        if res.get("changed_files") != 1:
            fails.append(f"case 7: want changed_files=1, got {res.get('changed_files')}")
        if res.get("changed_files_raw") != 2:
            fails.append(f"case 7: want changed_files_raw=2, got {res.get('changed_files_raw')}")
        if res.get("excluded_count") != 1:
            fails.append(f"case 7: want excluded_count=1, got {res.get('excluded_count')}")
        if res.get("diff_lines") != 25:
            fails.append(f"case 7: want diff_lines=25, got {res.get('diff_lines')}")
        print("  ok    multi-page PR is slurped and aggregated across pages")

    # -------------------------------------------------------------
    # 8. gh api failure fails step with exit 1 (#140, finding 3944010346)
    # -------------------------------------------------------------
    rc, outs, res, stdout, _ = run_filter_step(
        filter_script,
        gh_fail=True,
    )
    if rc != 1:
        fails.append(f"case 8: expected rc=1 on gh api failure, got {rc}")
    else:
        print("  ok    gh api failure exits 1")

    # -------------------------------------------------------------
    # 9. JSON parse error fails step with exit 1 (#140, finding 3944010346)
    # -------------------------------------------------------------
    rc, outs, res, stdout, _ = run_filter_step(
        filter_script,
        gh_malformed=True,
    )
    if rc != 1:
        fails.append(f"case 9: expected rc=1 on malformed JSON, got {rc}")
    else:
        print("  ok    malformed PR files JSON exits 1")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
