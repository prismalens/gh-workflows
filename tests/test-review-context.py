#!/usr/bin/env python3
"""Behavioural tests for the review context family (#143-#147).

Extracts the REAL shell body of 'Build review context' out of claude-code-review.yml
and runs it in a real git repository (some checks read the filesystem directly)
against a stubbed `gh`, verifying:

1. An issue reference the PR body carries that cannot be fetched is recorded under
   `context.issues.unresolved` with a reason, never silently dropped (#143).
2. A still-pending check produces `context.ci_failures.state == "pending"` and the
   step still exits 0 -- the lane never waits for or blocks on CI (#145).
3. A lockfile format with no parser wired yields `unparsed: [<path>]`, never a
   guessed delta (#147).
4. `context.profile` reads languages, package managers, scripts, ci triggers and
   config_files from the checkout by presence/extension alone (#144).
5. A tool that is unavailable is recorded under `tool_findings.skipped`, and the
   step still succeeds -- a tool's failure to run is never fatal (#146).
6. With nothing to report (no issue refs, CI green, no lockfile change, no
   applicable tools), `context_notes` is empty: a repo that configures nothing
   gets empty context and no liveness caveat.
7. Defect hunt (#105 surface): issue_context_total_byte_budget is a ceiling on the
   FIRST resolved issue too, not just the second and later ones. A per-issue budget
   (issue_context_byte_budget) configured larger than the total must not let one
   oversized entry slip through the total budget unresolved-and-unrecorded.

Run: python3 tests/test-review-context.py
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
STEP_NAME = "Build review context"

# A stub actionlint that never touches the network: it is what stands in the stub
# PATH ahead of any pinned-download fallback the real step would otherwise try.
ACTIONLINT_STUB = """#!/usr/bin/env bash
if [ "$1" = "-format" ]; then
  printf '%s' "${FAKE_ACTIONLINT_JSON:-[]}"
  exit 0
fi
exit 0
"""


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
    subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "base"], cwd=tdp, check=True)
    base_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tdp, check=True, capture_output=True, text=True
    ).stdout.strip()
    return base_sha


def run_context_step(
    script,
    *,
    manifest_files,
    gh_routes: str,
    repo_files=None,
    language_map=None,
    tool_findings=None,
    issue_byte_budget="",
    issue_total_byte_budget="",
    config_resolution=None,
    actionlint_json=None,
):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        base_sha = init_repo(tdp, repo_files)

        (tdp / ".claude-review-manifest.json").write_text(
            json.dumps({"files": manifest_files, "context": {}}), encoding="utf-8"
        )

        binp = tdp / "bin"
        binp.mkdir()
        gh_stub = binp / "gh"
        gh_stub.write_text(f"""#!/usr/bin/env bash
args="$*"
{gh_routes}
echo "gh stub: unrouted call: $args" >&2
exit 1
""")
        gh_stub.chmod(0o755)

        (binp / "actionlint").write_text(ACTIONLINT_STUB)
        (binp / "actionlint").chmod(0o755)

        out_file = tdp / "output.txt"
        out_file.touch()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env.get('PATH', '')}",
            GITHUB_OUTPUT=str(out_file),
            GITHUB_WORKSPACE=str(tdp),
            REPO="test-org/test-repo",
            PR="105",
            HEAD_SHA="deadbeefcafebabedeadbeefcafebabedeadbeef",
            BASE_SHA=base_sha,
            CONFIG_RESOLUTION=json.dumps(config_resolution or {}),
            LANGUAGE_MAP=json.dumps(language_map) if language_map is not None else "{}",
            TOOL_FINDINGS=json.dumps(tool_findings) if tool_findings is not None else "[]",
            ISSUE_BYTE_BUDGET=str(issue_byte_budget),
            ISSUE_TOTAL_BYTE_BUDGET=str(issue_total_byte_budget),
        )
        if actionlint_json is not None:
            env["FAKE_ACTIONLINT_JSON"] = json.dumps(actionlint_json)

        p = subprocess.run(
            ["bash", "-c", script], env=env, cwd=str(tdp), capture_output=True, text=True, timeout=60,
        )

        outputs = {}
        if out_file.exists():
            for line in out_file.read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    outputs[k] = v

        manifest = json.loads((tdp / ".claude-review-manifest.json").read_text(encoding="utf-8"))
        return p.returncode, outputs, manifest, p.stdout, p.stderr


def main():
    fails = []
    script = extract_step_script()

    print(f"=== Testing {STEP_NAME!r} ===\n")

    # -------------------------------------------------------------
    # 1. An unresolvable issue reference is recorded, not dropped (#143)
    # -------------------------------------------------------------
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":"Closes #10 and refs #999.\n\nSecond paragraph, ignored."}'
  exit 0
fi
if [[ "$args" == *"issues/10/comments"* ]]; then
  echo '[{"author_association":"MEMBER","body":"## Ruling\nDo the thing."}]'
  exit 0
fi
if [[ "$args" == *"issues/10"* ]]; then
  echo '{"title":"Do the thing","body":"Please do the thing.","labels":[{"name":"bug"}],"html_url":"https://x/10"}'
  exit 0
fi
if [[ "$args" == *"issues/999"* ]]; then
  echo "gh: not found (HTTP 404)" >&2
  exit 1
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[]}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[{"path": "README.md", "status": "modified"}],
        gh_routes=gh_routes,
    )
    if rc != 0:
        fails.append(f"case 1 failed with rc={rc}: {stderr}")
    else:
        issues = manifest["context"]["issues"]
        resolved_numbers = {e["number"] for e in issues["resolved"]}
        unresolved_refs = {e["ref"] for e in issues["unresolved"]}
        if resolved_numbers != {10}:
            fails.append(f"case 1: want resolved={{10}}, got {resolved_numbers}")
        if unresolved_refs != {999}:
            fails.append(f"case 1: want unresolved={{999}}, got {unresolved_refs}")
        elif not issues["unresolved"][0].get("reason"):
            fails.append("case 1: unresolved entry has no reason")
        if "#999" not in outs.get("context_notes", ""):
            fails.append(f"case 1: liveness context_notes should mention #999, got {outs.get('context_notes')!r}")
        else:
            print("  ok    an unresolvable issue reference is recorded with a reason, not dropped")

    # -------------------------------------------------------------
    # 2. A pending check yields the pending verdict and does not block (#145)
    # -------------------------------------------------------------
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":""}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[{"name":"build","status":"in_progress","conclusion":null,"app":{"slug":"github-actions"}}]}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[{"path": "README.md", "status": "modified"}],
        gh_routes=gh_routes,
    )
    if rc != 0:
        fails.append(f"case 2 failed with rc={rc} (a pending check must never fail or block the round): {stderr}")
    else:
        ci = manifest["context"]["ci_failures"]
        if ci["state"] != "pending":
            fails.append(f"case 2: want state=pending, got {ci}")
        elif "build" not in ci["pending"]:
            fails.append(f"case 2: want 'build' listed pending, got {ci['pending']}")
        else:
            print("  ok    a pending check produces the pending verdict and does not block the round")

    # -------------------------------------------------------------
    # 3. An unknown lockfile format yields `unparsed`, never a guess (#147)
    # -------------------------------------------------------------
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":""}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[]}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[{"path": "yarn.lock", "status": "modified"}],
        gh_routes=gh_routes,
    )
    if rc != 0:
        fails.append(f"case 3 failed with rc={rc}: {stderr}")
    else:
        deps = manifest["context"]["dependencies"]
        if deps.get("unparsed") != ["yarn.lock"]:
            fails.append(f"case 3: want unparsed=['yarn.lock'], got {deps}")
        elif deps["added"] or deps["removed"] or deps["bumped"]:
            fails.append(f"case 3: an unparsed lockfile must report no delta, got {deps}")
        else:
            print("  ok    an unparsed lockfile format reports 'unparsed', never a guessed delta")

    # -------------------------------------------------------------
    # 3b. A parseable npm lockfile reports a real added/removed/bumped delta (#147)
    # -------------------------------------------------------------
    before_lock = json.dumps({
        "packages": {
            "": {},
            "node_modules/left-pad": {"version": "1.0.0"},
            "node_modules/old-dep": {"version": "2.0.0"},
        }
    })
    after_lock = json.dumps({
        "packages": {
            "": {},
            "node_modules/left-pad": {"version": "1.1.0"},
            "node_modules/new-dep": {"version": "3.0.0"},
        }
    })
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":""}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[]}'
  exit 0
fi
"""
    with tempfile.TemporaryDirectory() as td2:
        tdp2 = pathlib.Path(td2)
        base_sha = init_repo(tdp2, {"package-lock.json": before_lock})
        (tdp2 / "package-lock.json").write_text(after_lock, encoding="utf-8")
        (tdp2 / ".claude-review-manifest.json").write_text(
            json.dumps({"files": [{"path": "package-lock.json", "status": "modified"}], "context": {}})
        )
        binp = tdp2 / "bin"
        binp.mkdir()
        (binp / "gh").write_text(f"""#!/usr/bin/env bash
args="$*"
{gh_routes}
echo "gh stub: unrouted: $args" >&2
exit 1
""")
        (binp / "gh").chmod(0o755)
        (binp / "actionlint").write_text(ACTIONLINT_STUB)
        (binp / "actionlint").chmod(0o755)
        out_file = tdp2 / "output.txt"
        out_file.touch()
        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env.get('PATH', '')}",
            GITHUB_OUTPUT=str(out_file),
            GITHUB_WORKSPACE=str(tdp2),
            REPO="test-org/test-repo",
            PR="105",
            HEAD_SHA="deadbeefcafebabedeadbeefcafebabedeadbeef",
            BASE_SHA=base_sha,
            CONFIG_RESOLUTION="{}",
            LANGUAGE_MAP="{}",
            TOOL_FINDINGS="[]",
            ISSUE_BYTE_BUDGET="2000",
            ISSUE_TOTAL_BYTE_BUDGET="8000",
        )
        p = subprocess.run(["bash", "-c", script], env=env, cwd=str(tdp2), capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            fails.append(f"case 3b failed with rc={p.returncode}: {p.stderr}")
        else:
            deps = json.loads((tdp2 / ".claude-review-manifest.json").read_text())["context"]["dependencies"]
            added_names = {e["name"] for e in deps["added"]}
            removed_names = {e["name"] for e in deps["removed"]}
            bumped_names = {e["name"]: e["kind"] for e in deps["bumped"]}
            if added_names != {"new-dep"}:
                fails.append(f"case 3b: want added={{'new-dep'}}, got {added_names}")
            elif removed_names != {"old-dep"}:
                fails.append(f"case 3b: want removed={{'old-dep'}}, got {removed_names}")
            elif bumped_names != {"left-pad": "minor"}:
                fails.append(f"case 3b: want bumped left-pad=minor, got {bumped_names}")
            else:
                print("  ok    a real npm lockfile change reports added/removed/bumped with major/minor/patch")

    # -------------------------------------------------------------
    # 4. context.profile reads languages, scripts, ci triggers, config_files (#144)
    # -------------------------------------------------------------
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":""}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[]}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[
            {"path": "src/app.ts", "status": "modified"},
            {"path": "scripts/deploy.sh", "status": "modified"},
            {"path": "notes.xyz", "status": "added"},
        ],
        gh_routes=gh_routes,
        repo_files={
            "package.json": json.dumps({"scripts": {"test": "jest", "build": "tsc -p ."}}),
            "tsconfig.json": "{}",
            ".github/workflows/ci.yml": "name: CI\non: [push, pull_request]\njobs: {}\n",
        },
    )
    if rc != 0:
        fails.append(f"case 4 failed with rc={rc}: {stderr}")
    else:
        profile = manifest["context"]["profile"]
        if profile["languages"].get("TypeScript") != 1:
            fails.append(f"case 4: want TypeScript=1, got {profile['languages']}")
        elif profile["languages"].get("Shell") != 1:
            fails.append(f"case 4: want Shell=1, got {profile['languages']}")
        elif profile["languages"].get("other") != 1:
            fails.append(f"case 4: unknown extension must count as 'other', got {profile['languages']}")
        elif profile["scripts"].get("test") != "jest":
            fails.append(f"case 4: want scripts.test='jest', got {profile['scripts']}")
        elif "tsconfig.json" not in profile["config_files"]:
            fails.append(f"case 4: want tsconfig.json in config_files, got {profile['config_files']}")
        elif set(profile["ci"].get("ci.yml", [])) != {"push", "pull_request"}:
            fails.append(f"case 4: want ci.yml triggers push+pull_request, got {profile['ci']}")
        else:
            print("  ok    profile reads languages (unknown extensions as 'other'), scripts, ci triggers, config_files")

    # -------------------------------------------------------------
    # 5. A tool that cannot run is recorded, never fatal (#146)
    # -------------------------------------------------------------
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":""}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[]}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[{"path": "src/app.ts", "status": "modified"}],
        gh_routes=gh_routes,
        repo_files={"tsconfig.json": "{}"},
    )
    if rc != 0:
        fails.append(f"case 5 failed with rc={rc} (a missing tool must never fail the round): {stderr}")
    else:
        skipped = {s["tool"]: s["reason"] for s in manifest["context"]["tool_findings"]["skipped"]}
        if "tsc" not in skipped:
            fails.append(f"case 5: want tsc recorded as skipped (no node_modules), got {manifest['context']['tool_findings']}")
        elif "tsc" not in outs.get("context_notes", ""):
            fails.append(f"case 5: context_notes should mention the failed tool, got {outs.get('context_notes')!r}")
        else:
            print("  ok    a tool that cannot run is recorded under skipped and never fails the round")

    # -------------------------------------------------------------
    # 6. Nothing to report: context_notes is empty, no false caveat (#143-#147)
    # -------------------------------------------------------------
    gh_routes = r"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{"body":""}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{"check_runs":[{"name":"build","status":"completed","conclusion":"success","app":{"slug":"github-actions"}}]}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[{"path": "README.md", "status": "modified"}],
        gh_routes=gh_routes,
    )
    if rc != 0:
        fails.append(f"case 6 failed with rc={rc}: {stderr}")
    elif outs.get("context_notes", "") != "":
        fails.append(f"case 6: want empty context_notes with nothing to report, got {outs.get('context_notes')!r}")
    elif manifest["context"]["issues"] != {"resolved": [], "unresolved": []}:
        fails.append(f"case 6: want empty context.issues with no PR body references, got {manifest['context']['issues']}")
    else:
        print("  ok    a repo/PR with nothing to report gets empty context and no liveness caveat")

    # -------------------------------------------------------------
    # 7. issue_context_total_byte_budget is a ceiling on the FIRST issue too
    # (defect hunt, #105 surface). A per-issue budget configured larger than the
    # total must not silently exempt the first resolved issue from that ceiling.
    # -------------------------------------------------------------
    big_body = "x" * 2500  # over the 2000-byte total budget below, under the 3000 per-issue one
    gh_routes = rf"""
if [[ "$args" == *"pulls/105"* ]]; then
  echo '{{"body":"Closes #10."}}'
  exit 0
fi
if [[ "$args" == *"issues/10/comments"* ]]; then
  echo '[]'
  exit 0
fi
if [[ "$args" == *"issues/10"* ]]; then
  echo '{{"title":"Big issue","body":"{big_body}","labels":[],"html_url":"https://x/10"}}'
  exit 0
fi
if [[ "$args" == *"check-runs"* ]]; then
  echo '{{"check_runs":[]}}'
  exit 0
fi
"""
    rc, outs, manifest, stdout, stderr = run_context_step(
        script,
        manifest_files=[{"path": "README.md", "status": "modified"}],
        gh_routes=gh_routes,
        issue_byte_budget="3000",
        issue_total_byte_budget="2000",
    )
    if rc != 0:
        fails.append(f"case 7 failed with rc={rc}: {stderr}")
    else:
        issues = manifest["context"]["issues"]
        resolved_numbers = {e["number"] for e in issues["resolved"]}
        unresolved_refs = {e["ref"] for e in issues["unresolved"]}
        if resolved_numbers:
            fails.append(
                f"case 7: the first issue alone (2500+ bytes) exceeds the 2000-byte total budget "
                f"and must not be resolved regardless of being first; got resolved={resolved_numbers}"
            )
        elif unresolved_refs != {10}:
            fails.append(f"case 7: want unresolved={{10}}, got {unresolved_refs}")
        elif "total issue context byte budget exhausted" not in issues["unresolved"][0].get("reason", ""):
            fails.append(f"case 7: want the budget-exhausted reason, got {issues['unresolved'][0]}")
        else:
            print("  ok    the total issue-context byte budget is enforced on the first resolved issue too")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
