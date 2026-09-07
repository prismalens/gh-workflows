#!/usr/bin/env python3
"""Behavioural tests for the review manifest and reviewable_lines size cap (#105).

Extracts the REAL shell body of 'Build review manifest' out of claude-code-review.yml
and runs it in a real git repository (git grep needs one) against a stubbed `gh`,
verifying:

1. A pure deletion contributes 0 reviewable lines and carries `references`.
2. A file excluded by a default path filter is listed with the matching filter name
   and contributes 0 reviewable lines.
3. A diff over `max_reviewable_lines` refuses (posts nothing) rather than trimming:
   `reviewable_lines` is reported in full, `refused=true`, and the manifest/diff are
   still written whole.
4. A file over `max_file_lines` is listed `oversized` and contributes 0.
5. `@claude full review` (mode `review-full`) overrides the cap for that one round and
   is recorded as `size_override`.
6. `max_reviewable_lines=0` disables the cap.
7. Added and modified files are summed into `reviewable_lines`.
8. Incremental mode reads the (pre-filter) range file rather than calling `gh`.

Run: python3 tests/test-review-manifest.py
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
STEP_NAME = "Build review manifest"


def extract_step_script() -> str:
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP_NAME:
                return step["run"]
    sys.exit(f"step {STEP_NAME!r} not found in {WF}")


def init_repo(tdp: pathlib.Path, repo_files: dict):
    subprocess.run(["git", "init", "-q"], cwd=tdp, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tdp, check=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=tdp, check=True)
    for relpath, content in (repo_files or {}).items():
        p = tdp / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tdp, check=True)
    # An empty commit is fine when repo_files is empty; grep on an empty tree just
    # finds nothing, which is itself a case worth exercising.
    subprocess.run(
        ["git", "commit", "-q", "--allow-empty", "-m", "fixture"], cwd=tdp, check=True
    )


def run_manifest_step(
    script,
    *,
    mode="review",
    gh_files_json=None,
    incremental_files=None,
    path_filters=None,
    config_resolution=None,
    max_reviewable_lines="",
    max_file_lines="",
    repo_files=None,
    gh_fail=False,
):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        init_repo(tdp, repo_files)

        binp = tdp / "bin"
        binp.mkdir()
        gh_stub = binp / "gh"
        # `gh api --paginate --slurp` wraps each page's array into an outer array, one
        # entry per page. A plain list fixture is a single page, so it needs wrapping.
        if gh_files_json is None:
            files_payload = json.dumps([[]])
        elif gh_files_json and isinstance(gh_files_json[0], list):
            files_payload = json.dumps(gh_files_json)
        else:
            files_payload = json.dumps([gh_files_json])
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

        if mode == "incremental" and incremental_files is not None:
            range_data = {"files": incremental_files}
            (tdp / ".claude-incremental-range.json").write_text(json.dumps(range_data), encoding="utf-8")

        out_file = tdp / "output.txt"
        out_file.touch()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env.get('PATH', '')}",
            GITHUB_OUTPUT=str(out_file),
            GITHUB_WORKSPACE=str(tdp),
            MODE=mode,
            REPO="test-org/test-repo",
            PR="105",
            FAKE_GH_FAIL="1" if gh_fail else "0",
            MAX_REVIEWABLE_LINES=str(max_reviewable_lines),
            MAX_FILE_LINES=str(max_file_lines),
        )
        env["PATH_FILTERS"] = json.dumps(path_filters) if path_filters is not None else "[]"
        env["CONFIG_RESOLUTION"] = json.dumps(config_resolution) if config_resolution is not None else "{}"

        p = subprocess.run(["bash", "-c", script], env=env, cwd=str(tdp),
                           capture_output=True, text=True)

        outputs = {}
        if out_file.exists():
            for line in out_file.read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    outputs[k] = v

        manifest = None
        manifest_path = tdp / ".claude-review-manifest.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                manifest = "MALFORMED"

        diff_text = None
        diff_path = tdp / ".claude-review.diff"
        if diff_path.exists():
            diff_text = diff_path.read_text(encoding="utf-8")

        return p.returncode, outputs, manifest, diff_text, p.stdout, p.stderr


def by_path(manifest, path):
    # The manifest is {"files": [...], "context": {...}} (#143-#147); this step only
    # ever writes "files" and leaves "context" as the empty placeholder for the next
    # step ("Build review context") to fill in.
    return next((e for e in manifest["files"] if e["path"] == path), None)


def main():
    fails = []
    script = extract_step_script()

    print(f"=== Testing {STEP_NAME!r} ===\n")

    # -------------------------------------------------------------
    # 1. Pure deletion: 0 reviewable lines, references computed
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "src/old.py", "status": "removed", "additions": 0, "deletions": 40, "patch": "@@ -1,40 +0,0 @@\n-old code\n"},
        ],
        repo_files={"docs/notes.md": "See src/old.py for the previous implementation.\n"},
        max_reviewable_lines="1000",
    )
    if rc != 0:
        fails.append(f"case 1 failed with rc={rc}: {stderr}")
    else:
        entry = by_path(manifest, "src/old.py")
        if entry is None:
            fails.append("case 1: manifest has no entry for src/old.py")
        else:
            if entry["status"] != "deleted":
                fails.append(f"case 1: want status=deleted, got {entry['status']}")
            if "docs/notes.md" not in entry["references"]:
                fails.append(f"case 1: expected docs/notes.md in references, got {entry['references']}")
        if outs.get("reviewable_lines") != "0":
            fails.append(f"case 1: want reviewable_lines=0, got {outs.get('reviewable_lines')}")
        print("  ok    a pure deletion contributes 0 reviewable lines and carries references")

    # -------------------------------------------------------------
    # 2. Path-filtered file is listed with the matching filter name
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "package-lock.json", "status": "modified", "additions": 5000, "deletions": 10, "patch": "@@ ... @@"},
            {"filename": "src/app.ts", "status": "modified", "additions": 10, "deletions": 2, "patch": "@@ ... @@"},
        ],
        max_reviewable_lines="1000",
    )
    if rc != 0:
        fails.append(f"case 2 failed with rc={rc}: {stderr}")
    else:
        entry = by_path(manifest, "package-lock.json")
        if entry is None or entry.get("filtered_by") != "package-lock.json":
            fails.append(f"case 2: want filtered_by='package-lock.json', got {entry}")
        if outs.get("reviewable_lines") != "12":
            fails.append(f"case 2: want reviewable_lines=12 (only src/app.ts), got {outs.get('reviewable_lines')}")
        if diff_text and "package-lock.json" in diff_text:
            fails.append("case 2: filtered file's patch leaked into .claude-review.diff")
        print("  ok    a filtered file is listed with its filter name and excluded from the diff")

    # -------------------------------------------------------------
    # 3. Over the cap: refuses rather than trimming
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "src/big.py", "status": "modified", "additions": 800, "deletions": 0, "patch": "@@ ... @@"},
        ],
        mode="review",
        max_reviewable_lines="100",
    )
    if rc != 0:
        fails.append(f"case 3 failed with rc={rc}: {stderr}")
    else:
        if outs.get("refused") != "true":
            fails.append(f"case 3: want refused=true, got {outs.get('refused')}")
        if outs.get("reviewable_lines") != "800":
            fails.append(f"case 3: want the full reviewable_lines=800 reported (not trimmed), got {outs.get('reviewable_lines')}")
        entry = by_path(manifest, "src/big.py")
        if entry is None or entry.get("filtered_by") is not None:
            fails.append(f"case 3: refusal must not mark the file filtered/trimmed, got {entry}")
        print("  ok    a diff over the cap refuses and still reports the untrimmed reviewable_lines")

    # -------------------------------------------------------------
    # 4. A single oversized file is excluded like a filtered one
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "src/huge.py", "status": "added", "additions": 3000, "deletions": 0, "patch": "@@ ... @@"},
            {"filename": "src/small.py", "status": "added", "additions": 5, "deletions": 0, "patch": "@@ ... @@"},
        ],
        max_reviewable_lines="100000",
        max_file_lines="2000",
    )
    if rc != 0:
        fails.append(f"case 4 failed with rc={rc}: {stderr}")
    else:
        entry = by_path(manifest, "src/huge.py")
        if entry is None or entry.get("filtered_by") != "oversized":
            fails.append(f"case 4: want filtered_by='oversized', got {entry}")
        if outs.get("reviewable_lines") != "5":
            fails.append(f"case 4: want reviewable_lines=5 (huge.py excluded), got {outs.get('reviewable_lines')}")
        print("  ok    a file over max_file_lines is listed oversized and excluded")

    # -------------------------------------------------------------
    # 5. review-full overrides the cap and is recorded as size_override
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "src/big.py", "status": "modified", "additions": 800, "deletions": 0, "patch": "@@ ... @@"},
        ],
        mode="review-full",
        max_reviewable_lines="100",
    )
    if rc != 0:
        fails.append(f"case 5 failed with rc={rc}: {stderr}")
    else:
        if outs.get("refused") != "false":
            fails.append(f"case 5: want refused=false under review-full, got {outs.get('refused')}")
        if outs.get("size_override") != "true":
            fails.append(f"case 5: want size_override=true, got {outs.get('size_override')}")
        print("  ok    review-full overrides the cap and records size_override")

    # -------------------------------------------------------------
    # 6. max_reviewable_lines=0 disables the cap
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "src/big.py", "status": "modified", "additions": 9000, "deletions": 0, "patch": "@@ ... @@"},
        ],
        mode="review",
        max_reviewable_lines="0",
    )
    if rc != 0:
        fails.append(f"case 6 failed with rc={rc}: {stderr}")
    elif outs.get("refused") != "false":
        fails.append(f"case 6: want refused=false when max_reviewable_lines=0, got {outs.get('refused')}")
    else:
        print("  ok    max_reviewable_lines=0 disables the cap")

    # -------------------------------------------------------------
    # 7. Added and modified files are summed
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        gh_files_json=[
            {"filename": "src/new.py", "status": "added", "additions": 30, "deletions": 0, "patch": "@@ ... @@"},
            {"filename": "src/edit.py", "status": "modified", "additions": 4, "deletions": 6, "patch": "@@ ... @@"},
        ],
        max_reviewable_lines="1000",
    )
    if rc != 0:
        fails.append(f"case 7 failed with rc={rc}: {stderr}")
    else:
        if outs.get("reviewable_lines") != "40":
            fails.append(f"case 7: want reviewable_lines=40, got {outs.get('reviewable_lines')}")
        if diff_text is None or "src/new.py" not in diff_text or "src/edit.py" not in diff_text:
            fails.append("case 7: both reviewable files expected in .claude-review.diff")
        print("  ok    added and modified files are summed into reviewable_lines")

    # -------------------------------------------------------------
    # 8. Incremental mode reads the range file, not `gh`
    # -------------------------------------------------------------
    rc, outs, manifest, diff_text, stdout, stderr = run_manifest_step(
        script,
        mode="incremental",
        incremental_files=[
            {"filename": "src/inc.py", "status": "modified", "additions": 7, "deletions": 1, "patch": "@@ ... @@"},
        ],
        max_reviewable_lines="1000",
        gh_fail=True,  # if the step called `gh` here, it would fail the step
    )
    if rc != 0:
        fails.append(f"case 8 failed with rc={rc}: {stderr}")
    elif outs.get("reviewable_lines") != "8":
        fails.append(f"case 8: want reviewable_lines=8, got {outs.get('reviewable_lines')}")
    else:
        print("  ok    incremental mode reads the range file directly, without calling gh")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
