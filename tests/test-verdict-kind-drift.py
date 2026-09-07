#!/usr/bin/env python3
"""Every verdict_kind the lane emits must be one the dashboard knows.

`decodeVerdictKind` buckets an unrecognised kind as `error`, so a kind the
workflow emits and `verdict.ts` has never heard of is displayed as a failed
round. That is the reads-as-something-it-is-not failure this repository exists
to catch, and it had already happened three times before this check: the lane
emitted `paused-by-request`, `skipped-trivial` and `superseded` while the
dashboard bucketed all three as errors. Story: gh-workflows#149, #153.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/claude-code-review.yml"
VERDICT_TS = ROOT / "dashboard/src/honesty/verdict.ts"


def emitted_kinds() -> set[str]:
    text = WORKFLOW.read_text(encoding="utf-8")
    found = set(re.findall(r'verdict_kind="([a-z-]+)"', text))
    # The initialiser, not a state.
    found.discard("")
    return found


def known_kinds() -> set[str]:
    text = VERDICT_TS.read_text(encoding="utf-8")
    block = re.search(r"export const ALL_VERDICT_KINDS = \[(.*?)\] as const;", text, re.S)
    if not block:
        print("::error::ALL_VERDICT_KINDS not found in dashboard/src/honesty/verdict.ts")
        sys.exit(1)
    return set(re.findall(r'"([a-z-]+)"', block.group(1)))


def mapped_kinds(const_name: str) -> set[str]:
    text = VERDICT_TS.read_text(encoding="utf-8")
    block = re.search(rf"{const_name}[^=]*= \{{(.*?)\n\}};", text, re.S)
    if not block:
        print(f"::error::{const_name} not found in dashboard/src/honesty/verdict.ts")
        sys.exit(1)
    return set(re.findall(r'^\s*"?([a-z-]+)"?:', block.group(1), re.M))


def main() -> None:
    emitted = emitted_kinds()
    known = known_kinds()
    fails = []

    missing = sorted(emitted - known)
    if missing:
        fails.append(
            "emitted by the lane, unknown to the dashboard (each would display as an "
            f"error): {', '.join(missing)}"
        )

    # The reverse is not an error on its own: `clean` and `error` are dashboard-side
    # vocabulary. Only kinds declared in ALL_VERDICT_KINDS must be emittable.
    stale = sorted(known - emitted)
    if stale:
        fails.append(
            f"declared in ALL_VERDICT_KINDS but never emitted by the workflow: {', '.join(stale)}"
        )

    for const_name in ("VERDICT_KIND_MAP", "VERDICT_KIND_BUCKET_MAP"):
        unmapped = sorted(known - mapped_kinds(const_name))
        if unmapped:
            fails.append(f"{const_name} has no entry for: {', '.join(unmapped)}")

    print(f"{len(emitted)} kind(s) emitted, {len(known)} known to the dashboard")
    if fails:
        for f in fails:
            print(f"::error::Verdict kind drift: {f}")
        sys.exit(1)
    print("all verdict kinds are emitted, declared, mapped and bucketed")


if __name__ == "__main__":
    main()
