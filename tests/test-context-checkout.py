#!/usr/bin/env python3
"""Behavioural tests for the "Check out declared context repositories" step (#90).

Extracts the REAL shell body out of claude-code-review.yml and runs it against a stubbed
`gh` and a stubbed `git`, verifying:

1. A private (or unreachable) repository is skipped with a warning, and the step exits 0.
2. A `git clone` failure is skipped with a warning, and the step exits 0.
3. An entry whose lines would push the running total over `max_context_lines` is dropped,
   with a warning, and the earlier kept entry stays kept.
4. `.claude-context.json` lists only the kept entries, with `sha` resolved and `lines` set.
5. `max_context_lines` disables checkout entirely at 0.

Run: python3 tests/test-context-checkout.py
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
STEP_NAME = "Check out declared context repositories"


def extract_step_script() -> str:
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP_NAME:
                return step["run"]
    sys.exit(f"step {STEP_NAME!r} not found in {WF}")


# repos/{repo} --jq .private and repos/{repo}/commits/{ref} --jq .sha, keyed off env lists.
GH_STUB = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/commits/"*)
    repo=$(echo "$args" | sed -E 's#.*repos/([^ ]+)/commits/.*#\1#')
    echo "sha-${repo//\//-}"
    exit 0 ;;
  *)
    repo=$(echo "$args" | sed -E 's#.*repos/([^ ]+) .*#\1#; s#.*repos/([^ ]+)$#\1#')
    if [[ ",${FAKE_PRIVATE_REPOS:-}," == *",${repo},"* ]]; then
      echo "true"
    else
      echo "false"
    fi
    exit 0 ;;
esac
"""

# clone / -C <target> fetch|sparse-checkout|checkout|ls-files, keyed off env lists.
GIT_STUB = r"""#!/usr/bin/env bash
if [ -n "${GIT_CALL_LOG:-}" ]; then
  echo "$*" >> "$GIT_CALL_LOG"
fi
if [ "$1" = "clone" ]; then
  url="${@: -2:1}"
  target="${@: -1}"
  repo="${url#https://github.com/}"
  repo="${repo%.git}"
  if [[ ",${FAKE_CLONE_FAIL_REPOS:-}," == *",${repo},"* ]]; then
    exit 1
  fi
  mkdir -p "$target"
  exit 0
fi
if [ "$1" = "-C" ]; then
  target="$2"
  sub="$3"
  repo="${target#.claude-context/}"
  case "$sub" in
    fetch) exit 0 ;;
    sparse-checkout) exit 0 ;;
    checkout)
      lines=$(jq -r --arg r "$repo" '.[$r] // 100' <<< "${FAKE_ENTRY_LINES_JSON:-{}}")
      seq 1 "$lines" > "$target/data.txt" 2>/dev/null || : > "$target/data.txt"
      exit 0 ;;
    ls-files)
      [ -f "$target/data.txt" ] && printf 'data.txt\0'
      exit 0 ;;
  esac
  exit 1
fi
exit 1
"""


def run_checkout_case(script, *, context_config, max_context_lines="3000",
                       private_repos="", clone_fail_repos="", entry_lines=None):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        (binp / "git").write_text(GIT_STUB)
        (binp / "git").chmod(0o755)
        out_file = tdp / "output.txt"
        out_file.touch()
        call_log = tdp / "git_calls.log"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            CONTEXT_CONFIG=json.dumps(context_config),
            MAX_CONTEXT_LINES=str(max_context_lines),
            METADATA_TOKEN="x",
            FAKE_PRIVATE_REPOS=private_repos,
            FAKE_CLONE_FAIL_REPOS=clone_fail_repos,
            FAKE_ENTRY_LINES_JSON=json.dumps(entry_lines or {}),
            GIT_CALL_LOG=str(call_log),
        )

        p = subprocess.run(["bash", "-c", script], env=env, cwd=str(tdp),
                            capture_output=True, text=True)
        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        context_json_path = tdp / ".claude-context.json"
        kept = json.loads(context_json_path.read_text()) if context_json_path.exists() else None

        return p.returncode, outputs, kept, p.stdout, p.stderr


def main():
    fails = []
    script = extract_step_script()

    def check(name, ok, detail=""):
        if ok:
            print(f"  ok    {name}")
        else:
            fails.append(f"{name}: {detail}")
            print(f"  FAIL  {name}: {detail}")

    print(f"=== Testing {STEP_NAME!r} (#90) ===\n")

    # 0. max_context_lines is declared on the callee, beside max_reviewable_lines (#90)
    wf = yaml.safe_load(WF.read_text())
    call_inputs = wf[True]["workflow_call"]["inputs"]  # PyYAML 1.1: bare 'on:' parses as True
    max_ctx_input = call_inputs.get("max_context_lines")
    check("max_context_lines is declared in on.workflow_call.inputs",
          max_ctx_input is not None, f"got keys {sorted(call_inputs.keys())}")
    if max_ctx_input is not None:
        check("max_context_lines defaults to 3000", max_ctx_input.get("default") == 3000, f"got {max_ctx_input}")
        check("max_context_lines has a description", bool(max_ctx_input.get("description")), f"got {max_ctx_input}")


    # 1. A private repository is skipped with a warning, step exits 0
    rc, outs, kept, stdout, stderr = run_checkout_case(
        script,
        context_config=[{"repository": "octo-org/private-lib", "ref": "main", "paths": ["x"]}],
        private_repos="octo-org/private-lib",
    )
    check("private repo: step exits 0", rc == 0, f"rc={rc}, stderr={stderr}")
    check("private repo: skipped, none kept", kept == [], f"kept={kept}")
    check("private repo: warns naming the repo", "::warning::" in stdout and "octo-org/private-lib" in stdout and "private" in stdout, f"stdout={stdout!r}")
    check("private repo: context_repositories=0", outs.get("context_repositories") == "0", f"outs={outs}")

    # 2. A clone failure is skipped with a warning, step exits 0
    rc, outs, kept, stdout, stderr = run_checkout_case(
        script,
        context_config=[{"repository": "octo-org/unreachable", "ref": "main", "paths": ["x"]}],
        clone_fail_repos="octo-org/unreachable",
    )
    check("clone failure: step exits 0", rc == 0, f"rc={rc}, stderr={stderr}")
    check("clone failure: skipped, none kept", kept == [], f"kept={kept}")
    check("clone failure: warns naming the repo", "::warning::" in stdout and "git clone failed" in stdout and "octo-org/unreachable" in stdout, f"stdout={stdout!r}")

    # 3. An over-cap entry is dropped and an earlier kept entry survives
    rc, outs, kept, stdout, stderr = run_checkout_case(
        script,
        context_config=[
            {"repository": "octo-org/small-lib", "ref": "main", "paths": ["x"]},
            {"repository": "octo-org/big-lib", "ref": "main", "paths": ["y"]},
        ],
        max_context_lines="1000",
        entry_lines={"octo-org/small-lib": 400, "octo-org/big-lib": 900},
    )
    check("over-cap: step exits 0", rc == 0, f"rc={rc}, stderr={stderr}")
    kept_repos = {e["repository"] for e in kept} if kept else set()
    check("over-cap: small-lib kept, big-lib dropped", kept_repos == {"octo-org/small-lib"}, f"kept={kept}")
    check("over-cap: warns naming the dropped repo and the budget", "::warning::" in stdout and "octo-org/big-lib" in stdout and "budget" in stdout, f"stdout={stdout!r}")
    check("over-cap: context_lines totals only the kept entry", outs.get("context_lines") == "400", f"outs={outs}")
    check("over-cap: context_repositories counts only the kept entry", outs.get("context_repositories") == "1", f"outs={outs}")

    # 4. .claude-context.json lists only the kept entries, sha resolved, lines set
    entry = kept[0] if kept else {}
    check(".claude-context.json entry carries repository/ref/sha/paths/lines",
          entry.get("repository") == "octo-org/small-lib"
          and entry.get("ref") == "main"
          and entry.get("sha") == "sha-octo-org-small-lib"
          and entry.get("paths") == ["x"]
          and entry.get("lines") == 400,
          f"entry={entry}")

    # 5. max_context_lines=0 disables checkout entirely, no gh or git call made
    rc, outs, kept, stdout, stderr = run_checkout_case(
        script,
        context_config=[{"repository": "octo-org/any", "ref": "main", "paths": ["x"]}],
        max_context_lines="0",
    )
    check("max_context_lines=0: step exits 0", rc == 0, f"rc={rc}, stderr={stderr}")
    check("max_context_lines=0: nothing kept", kept == [], f"kept={kept}")
    check("max_context_lines=0: no warning (feature disabled, not a skip)", "::warning::" not in stdout, f"stdout={stdout!r}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all context checkout tests passed")


if __name__ == "__main__":
    main()
