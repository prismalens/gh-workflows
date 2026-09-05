#!/usr/bin/env python3
"""Guards the claude-code-action pin against silent drift (#47 amendment).

`uses:` cannot take a `${{ }}` expression, so the pin is duplicated at two
`uses: anthropics/claude-code-action@<sha>` lines (review job, verify job) and mirrored
into the top-level `env.ACTION_VERSION`, which is what the telemetry ingest records.
Nothing on the platform keeps those three copies in sync; this is the thing that keeps
`action_version` honest after the next bump.

Run: python3 tests/test-action-version-drift.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"

ENV_RE = re.compile(r"^\s*ACTION_VERSION:\s*'([0-9a-f]{40})'\s*$", re.MULTILINE)
USES_RE = re.compile(r"^\s*uses:\s*anthropics/claude-code-action@([0-9a-f]{40})\b", re.MULTILINE)


def check(text):
    """Return (ok, message). Pure function so both the real file and fixtures can be checked."""
    env_matches = ENV_RE.findall(text)
    uses_matches = USES_RE.findall(text)

    if len(env_matches) != 1:
        return False, f"expected exactly one env.ACTION_VERSION assignment, found {len(env_matches)}"
    if len(uses_matches) != 2:
        return False, f"expected exactly two claude-code-action uses: pins, found {len(uses_matches)}"

    action_version = env_matches[0]
    disagreeing = [sha for sha in uses_matches if sha != action_version]
    if disagreeing:
        return False, (
            f"env.ACTION_VERSION ({action_version}) disagrees with uses: pin(s) {disagreeing}"
        )
    return True, "env.ACTION_VERSION matches both uses: pins"


def main():
    fails = []

    # Case 1: the real workflow file must be internally consistent today.
    real_text = WF.read_text(encoding="utf-8")
    ok, msg = check(real_text)
    if not ok:
        fails.append(f"real workflow file: {msg}")
        print(f"  FAIL  real workflow file: {msg}")
    else:
        print(f"  ok    real workflow file: {msg}")

    # Case 2: proof the check actually fails when the two pins disagree. Take the real
    # file and flip ONE uses: pin's last hex digit, leaving env.ACTION_VERSION untouched.
    match = USES_RE.search(real_text)
    if not match:
        fails.append("could not locate a uses: pin in the real file to build the drift fixture")
        print("  FAIL  drift fixture: no uses: pin found")
    else:
        original_sha = match.group(1)
        flipped_char = "0" if original_sha[-1] != "0" else "1"
        drifted_sha = original_sha[:-1] + flipped_char
        drifted_text = real_text[: match.start(1)] + drifted_sha + real_text[match.end(1):]

        ok, msg = check(drifted_text)
        if ok:
            fails.append("drift fixture: expected the check to fail on a disagreeing pin, but it passed")
            print("  FAIL  drift fixture: disagreeing pin was not caught")
        elif drifted_sha not in msg or original_sha not in msg:
            fails.append(f"drift fixture: failure message does not name both SHAs: {msg}")
            print(f"  FAIL  drift fixture: message missing a SHA: {msg}")
        else:
            print(f"  ok    drift fixture: disagreeing pin caught ({msg})")

    # Case 3: proof it also fails when ACTION_VERSION itself is missing (e.g. a bump that
    # forgot the env block entirely).
    no_env_text = ENV_RE.sub("", real_text, count=1)
    ok, msg = check(no_env_text)
    if ok:
        fails.append("missing-env fixture: expected the check to fail with no ACTION_VERSION, but it passed")
        print("  FAIL  missing-env fixture: absence was not caught")
    else:
        print(f"  ok    missing-env fixture: absence caught ({msg})")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all action_version drift checks passed")


if __name__ == "__main__":
    main()
