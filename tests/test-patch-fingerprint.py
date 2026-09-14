#!/usr/bin/env python3
"""Behavioural tests for patch fingerprint calculation (#162).

Extracts the REAL shell body of 'Compute patch fingerprint' out of claude-code-review.yml
and runs it against a stubbed `gh`, verifying:

1. Same +/- lines with different hunk headers or context lines give equal fingerprints.
2. File order in compare payload does not affect fingerprint (sorted by filename).
3. One changed +/- line gives a different fingerprint.
4. A file with no patch key yields an empty fingerprint.
5. A compare payload with 300 files (the API cap) yields an empty fingerprint.
6. A failed gh compare call yields an empty fingerprint.

Run: python3 tests/test-patch-fingerprint.py
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
STEP_NAME = "Compute patch fingerprint"

GH_STUB = r"""#!/usr/bin/env bash
args="$*"
case "$args" in
  *compare*)
    if [ "${FAKE_COMPARE_FAIL:-0}" = "1" ]; then
      echo "gh: comparison failed (HTTP 500)" >&2
      exit 1
    fi
    printf '%s\n' "$FAKE_COMPARE_JSON"
    exit 0 ;;
esac
echo "gh stub: unrouted call: $args" >&2
exit 1
"""


def extract_step_script() -> str:
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP_NAME:
                return step["run"]
    sys.exit(f"step {STEP_NAME!r} not found in {WF}")


def run_fingerprint(script: str, compare_data, fail: bool = False) -> str:
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        gh_stub = binp / "gh"
        gh_stub.write_text(GH_STUB, encoding="utf-8")
        gh_stub.chmod(0o755)

        out_file = tdp / "output.txt"
        out_file.touch()

        raw_json = json.dumps(compare_data) if isinstance(compare_data, (dict, list)) else str(compare_data)

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env.get('PATH', '')}",
            GITHUB_OUTPUT=str(out_file),
            GITHUB_REPOSITORY="test-org/test-repo",
            BASE_SHA="0" * 40,
            HEAD_SHA="1" * 40,
            FAKE_COMPARE_JSON=raw_json,
            FAKE_COMPARE_FAIL="1" if fail else "0",
        )

        p = subprocess.run(
            ["bash", "-c", script],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if p.returncode != 0:
            return f"EXIT_{p.returncode}: {p.stderr}"

        outputs = {}
        for line in out_file.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

        return outputs.get("patch_fingerprint", "")


def main():
    script = extract_step_script()
    fails = []

    print(f"=== Testing {STEP_NAME!r} ===\n")

    # 1. Same +/- lines with different hunk headers or context give equal fingerprints
    payload_a = {
        "files": [
            {
                "filename": "src/main.ts",
                "patch": "@@ -1,5 +1,6 @@\n context line 1\n context line 2\n-old line A\n+new line B\n trailing context\n",
            },
            {
                "filename": "src/utils.ts",
                "patch": "@@ -10,3 +10,4 @@\n ctx\n+added util\n",
            },
        ]
    }
    payload_b = {
        "files": [
            {
                "filename": "src/utils.ts",
                "patch": "@@ -50,10 +50,11 @@\n different context before\n+added util\n different context after\n",
            },
            {
                "filename": "src/main.ts",
                "patch": "@@ -80,20 +80,21 @@\n different context 1\n different context 2\n-old line A\n+new line B\n another trailing\n",
            },
        ]
    }
    fp_a = run_fingerprint(script, payload_a)
    fp_b = run_fingerprint(script, payload_b)

    if not fp_a or len(fp_a) != 64:
        fails.append(f"case 1: want 64-char hex sha256, got {fp_a!r}")
    elif fp_a != fp_b:
        fails.append(f"case 1: same +/- lines with different hunk headers/context gave different fingerprints: {fp_a} != {fp_b}")
    else:
        print("  ok    same +/- lines with different hunk headers/context/file order give equal fingerprints")

    # 2. One changed +/- line gives a different fingerprint
    payload_c = {
        "files": [
            {
                "filename": "src/main.ts",
                "patch": "@@ -1,5 +1,6 @@\n context line 1\n context line 2\n-old line A\n+new line C\n trailing context\n",
            },
            {
                "filename": "src/utils.ts",
                "patch": "@@ -10,3 +10,4 @@\n ctx\n+added util\n",
            },
        ]
    }
    fp_c = run_fingerprint(script, payload_c)
    if not fp_c or len(fp_c) != 64:
        fails.append(f"case 2: want 64-char hex sha256, got {fp_c!r}")
    elif fp_c == fp_a:
        fails.append("case 2: one changed + line gave the same fingerprint")
    else:
        print("  ok    one changed line gives a different fingerprint")

    # 3. A file with no patch key gives empty
    payload_no_patch = {
        "files": [
            {
                "filename": "src/main.ts",
                "patch": "@@ -1,3 +1,4 @@\n-old\n+new\n",
            },
            {
                "filename": "assets/logo.png",
            },
        ]
    }
    fp_no_patch = run_fingerprint(script, payload_no_patch)
    if fp_no_patch != "":
        fails.append(f"case 3: want empty fingerprint when any file has no patch, got {fp_no_patch!r}")
    else:
        print("  ok    a file with no patch key gives empty fingerprint")

    # 4. Compare payload with 300 entries (the API cap) gives empty
    payload_cap = {
        "files": [
            {
                "filename": f"file_{i:03d}.txt",
                "patch": "@@ -1,1 +1,1 @@\n+line\n",
            }
            for i in range(300)
        ]
    }
    fp_cap = run_fingerprint(script, payload_cap)
    if fp_cap != "":
        fails.append(f"case 4: want empty fingerprint at 300 files cap, got {fp_cap!r}")
    else:
        print("  ok    compare range with 300 files (API cap) gives empty fingerprint")

    # 5. Failed compare API call gives empty
    fp_fail = run_fingerprint(script, {}, fail=True)
    if fp_fail != "":
        fails.append(f"case 5: want empty fingerprint on API failure, got {fp_fail!r}")
    else:
        print("  ok    failed compare API call gives empty fingerprint")

    print()
    if fails:
        print(f"{len(fails)} FAILED")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("all patch fingerprint checks passed")


if __name__ == "__main__":
    main()
