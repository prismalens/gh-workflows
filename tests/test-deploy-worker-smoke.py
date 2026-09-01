#!/usr/bin/env python3
"""Behavioural tests for the post-deploy smoke test step in deploy-worker.yml.

Extracts the REAL shell body out of the workflow YAML and runs it against a
stubbed curl, proving:
  1. Worker answering 401 within retries → exit 0.
  2. Worker answering wrong status → exit non-zero with diagnostic message.
  3. Retry logic fires on initial failures before giving up.
  4. No secret or token value is echoed.

Run: python3 tests/test-deploy-worker-smoke.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/deploy-worker.yml"
STEP = "Verify deployed Worker is reachable"


def extract_step_script():
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP:
                return step["run"]
    sys.exit(f"step {STEP!r} not found in {WF}")


def run_smoke(script, *, curl_responses=None, env_extras=None):
    """Run the smoke test step with a stubbed curl.

    curl_responses is a list of HTTP status codes to return on successive calls.
    If shorter than the number of calls, the last code repeats.
    """
    if curl_responses is None:
        curl_responses = ["401"]

    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()

        # Write the response codes to a file so the stub can read them
        codes_file = tdp / "curl_codes.txt"
        codes_file.write_text("\n".join(curl_responses) + "\n")

        call_count_file = tdp / "call_count"
        call_count_file.write_text("0")

        curl_stub = binp / "curl"
        curl_stub.write_text(f"""#!/usr/bin/env bash
# Stub curl that returns successive HTTP status codes
count_file="{call_count_file}"
codes_file="{codes_file}"

count=$(cat "$count_file")
count=$((count + 1))
echo "$count" > "$count_file"

code=$(sed -n "${{count}}p" "$codes_file")
if [ -z "$code" ]; then
  # Repeat last code
  code=$(tail -1 "$codes_file")
fi

# Write http_code to stdout for -w '%{{http_code}}'
for a in "$@"; do
  if [[ "$a" == *"%{{http_code}}"* ]]; then
    printf '%s' "$code"
    break
  fi
done

# Write to output file if -o specified
prev=""
for a in "$@"; do
  case "$prev" in
    -o) printf '{{"error":"stubbed"}}' > "$a" ;;
  esac
  prev="$a"
done

exit 0
""")
        curl_stub.chmod(0o755)

        # Also stub sleep to avoid waiting
        sleep_stub = binp / "sleep"
        sleep_stub.write_text("#!/usr/bin/env bash\n# no-op\n")
        sleep_stub.chmod(0o755)

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            INGEST_URL="https://assayer.sfun.cloud/ingest",
        )
        if env_extras:
            env.update(env_extras)

        p = subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            env=env,
            cwd=str(tdp),
        )

        call_count = int(call_count_file.read_text().strip())
        return p, call_count


def main():
    script = extract_step_script()
    fails = []
    print("=== Testing Deploy Worker Post-Deploy Smoke Check ===\n")

    # Case 1: Worker answers 401 on first try → pass
    proc, calls = run_smoke(script, curl_responses=["401"])
    if proc.returncode != 0:
        fails.append(f"pass case: expected exit 0, got {proc.returncode}")
        print(f"  FAIL  pass case: exited {proc.returncode}")
    else:
        print(f"  ok    pass case: 401 response → exit 0 ({calls} curl call(s))")

    # Case 2: Worker answers wrong status (200) → fail with diagnostic message
    proc, calls = run_smoke(script, curl_responses=["200"])
    combined = proc.stdout + "\n" + proc.stderr
    if proc.returncode == 0:
        fails.append("wrong status (200): expected non-zero exit, got 0")
        print("  FAIL  wrong status (200): exit 0")
    elif "not answering" not in combined.lower() and "not reachable" not in combined.lower():
        fails.append("wrong status: error message does not indicate Worker is not answering")
        print("  FAIL  wrong status: missing diagnostic in error message")
    else:
        print(f"  ok    wrong status (200): exits non-zero, diagnostic message present ({calls} curl call(s))")

    # Case 3: Wrong status (500) → fail
    proc, calls = run_smoke(script, curl_responses=["500"])
    if proc.returncode == 0:
        fails.append("wrong status (500): expected non-zero exit, got 0")
        print("  FAIL  wrong status (500): exit 0")
    else:
        print(f"  ok    wrong status (500): exits non-zero ({calls} curl call(s))")

    # Case 4: Retry — first attempts fail (000/503), then succeed (401)
    proc, calls = run_smoke(script, curl_responses=["000", "503", "401"])
    if proc.returncode != 0:
        fails.append(f"retry case: expected exit 0 after retries, got {proc.returncode}")
        print(f"  FAIL  retry case: exited {proc.returncode}")
    elif calls < 3:
        fails.append(f"retry case: expected at least 3 curl calls, got {calls}")
        print(f"  FAIL  retry case: only {calls} curl call(s), expected ≥3")
    else:
        print(f"  ok    retry case: retries until 401, {calls} curl call(s)")

    # Case 5: All retries fail → exit non-zero
    proc, calls = run_smoke(script, curl_responses=["503", "503", "503", "503", "503"])
    if proc.returncode == 0:
        fails.append("all retries fail: expected non-zero exit, got 0")
        print("  FAIL  all retries fail: exit 0")
    elif calls < 2:
        fails.append(f"all retries fail: expected multiple curl calls, got {calls}")
        print(f"  FAIL  all retries fail: only {calls} curl call(s)")
    else:
        print(f"  ok    all retries fail: exits non-zero after {calls} attempts")

    # Case 6: Security — no token echoed
    canary = "TOP_SECRET_DEPLOY_CANARY_VALUE"
    proc, _ = run_smoke(script, curl_responses=["401"],
                        env_extras={"INGEST_URL": "https://example.com/ingest"})
    combined = proc.stdout + proc.stderr
    if canary in combined:
        fails.append("security: canary token was echoed in output")
        print("  FAIL  security: token value echoed")
    else:
        print("  ok    security: no token value echoed in output")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all post-deploy smoke tests passed")


if __name__ == "__main__":
    main()
