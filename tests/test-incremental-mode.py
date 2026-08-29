#!/usr/bin/env python3
"""Behavioural tests for incremental review mode resolution in `Detect verification mode`.

Extracts the REAL shell body out of claude-code-review.yml and runs it against a
stubbed `gh`, verifying mode resolution, range extraction, and fallback paths.

Run: python3 tests/test-incremental-mode.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP = "Detect verification mode"

OLD = "a" * 40
NEW = "b" * 40


def extract_step_script() -> str:
    import yaml
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


GH_STUB = r"""#!/usr/bin/env bash
# Stub `gh`. Routes on args for comments, graphql, and compare calls.
args="$*"
case "$args" in
  *claude-review-liveness*)
    printf '%s\n' "$FAKE_LIVENESS"
    exit 0 ;;
  *graphql*)
    printf '%s\n' "$FAKE_THREADS"
    exit 0 ;;
  *compare*)
    if [ "${FAKE_COMPARE_404:-0}" = "1" ]; then
      case "$args" in
        *"-i"*) printf 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}\n' ; exit 1 ;;
        *) exit 1 ;;
      esac
    fi
    case "$args" in
      *"-i"*) printf 'HTTP/2.0 200 OK\r\n\r\n%s\n' "$FAKE_COMPARE_JSON" ; exit 0 ;;
      *) printf '%s\n' "$FAKE_COMPARE_JSON" ; exit 0 ;;
    esac ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def run_case(script, *, event="pull_request", has_token="true", summon="none",
             max_rounds="5", head_sha=NEW, fake_liveness="", fake_threads="[]",
             fake_compare_json="{}", fake_compare_404="0"):
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        binp = td / "bin"
        binp.mkdir()
        (binp / "gh").write_text(GH_STUB)
        (binp / "gh").chmod(0o755)
        out_file = td / "output.txt"
        out_file.touch()

        range_file = pathlib.Path("/tmp/incremental-range.json")
        if range_file.exists():
            range_file.unlink()

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            GITHUB_OUTPUT=str(out_file),
            GH_TOKEN="x",
            REPO="o/r",
            PR="1",
            HEAD_SHA=head_sha,
            EVENT_NAME=event,
            SUMMON=summon,
            MAX_ROUNDS=str(max_rounds),
            HAS_TOKEN=has_token,
            FAKE_LIVENESS=fake_liveness,
            FAKE_THREADS=fake_threads,
            FAKE_COMPARE_JSON=fake_compare_json,
            FAKE_COMPARE_404=fake_compare_404,
        )
        p = subprocess.run(["bash", "-c", script], env=env,
                           capture_output=True, text=True)
        if p.returncode != 0:
            return None, f"script exited {p.returncode}: {p.stderr.strip()[:300]}"

        outputs = {}
        for line in out_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        return outputs, None


CASES = [
    # name, kwargs, want_mode, want_fallback_reason, want_skip_reason, want_range
    ("no token",
     dict(has_token="false"),
     "skip", "", "no-token", False),

    ("pull_request, rounds at limit",
     dict(fake_liveness="<!-- claude-review-liveness rounds=5 sha=" + OLD + " -->", max_rounds=5),
     "skip", "", "paused", False),

    ("pull_request, marker has no sha=",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 -->"),
     "review", "no-baseline", "", False),

    ("pull_request, compare ahead, 3 files",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}, {}, {}]})),
     "incremental", "", "", True),

    ("pull_request, baseline == head",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "skip", "no-new-commits", "no-new-commits", False),

    ("pull_request, compare diverged",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "diverged", "files": [{}]})),
     "review", "diverged", "", False),

    ("pull_request, compare behind",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "behind", "files": [{}]})),
     "review", "diverged", "", False),

    ("pull_request, compare 404",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_404="1"),
     "review", "baseline-gone", "", False),

    ("pull_request, compare ahead, 300 files",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "ahead", "files": [{}] * 300})),
     "review", "range-too-large", "", False),

    ("pull_request, compare status weird",
     dict(fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + OLD + " -->",
          fake_compare_json=json.dumps({"status": "weird", "files": [{}]})),
     "review", "unexpected-status-weird", "", False),

    ("summon full",
     dict(event="issue_comment", summon="full"),
     "review-full", "", "", False),

    ("summon review, 2 unresolved threads",
     dict(event="issue_comment", summon="incremental",
          fake_threads=json.dumps([
              {"thread_id": "T1", "path": "a.js", "root_id": 1, "url": "u1", "body": "b1"},
              {"thread_id": "T2", "path": "b.js", "root_id": 2, "url": "u2", "body": "b2"}
          ])),
     "verify", "", "", False),

    ("summon review, no threads, baseline == head",
     dict(event="issue_comment", summon="incremental", fake_threads="[]",
          fake_liveness="<!-- claude-review-liveness rounds=1 sha=" + NEW + " -->", head_sha=NEW),
     "review", "identical-summon", "", False),
]


def main():
    script = extract_step_script()
    fails = []

    print(f"running {len(CASES)} cases against the real step body\n")
    for name, kw, want_mode, want_fallback, want_skip, want_range in CASES:
        outputs, err = run_case(script, **kw)
        if err:
            fails.append(f"{name}: {err}")
            print(f"  ERROR  {name}: {err}")
            continue

        got_mode = outputs.get("mode")
        got_fallback = outputs.get("fallback_reason", "")
        got_skip = outputs.get("skip_reason", "")

        ok = (got_mode == want_mode)
        if want_fallback and got_fallback != want_fallback:
            ok = False
        if not want_fallback and got_fallback != "":
            ok = False
        if want_skip and got_skip != want_skip:
            ok = False
        if not want_skip and got_skip != "":
            ok = False

        if want_range:
            got_base = outputs.get("range_base")
            got_head = outputs.get("range_head")
            range_file = pathlib.Path("/tmp/incremental-range.json")
            if got_base != OLD or got_head != NEW:
                ok = False
            if not range_file.exists():
                ok = False

        if not ok:
            fails.append(
                f"{name}: want mode={want_mode!r} fallback={want_fallback!r} skip={want_skip!r}, "
                f"got mode={got_mode!r} fallback={got_fallback!r} skip={got_skip!r}"
            )
        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<48} mode={got_mode} fallback={got_fallback or '-'}")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
