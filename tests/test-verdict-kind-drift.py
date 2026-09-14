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
WORKER_INDEX = ROOT / "worker/index.js"


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


def lane_reason_to_verdict_kind() -> dict[str, str]:
    text = WORKER_INDEX.read_text(encoding="utf-8")
    block = re.search(r"const LANE_REASON_TO_VERDICT_KIND = \{(.*?)\n\};", text, re.S)
    if not block:
        print("::error::LANE_REASON_TO_VERDICT_KIND not found in worker/index.js")
        sys.exit(1)
    # Matches both quoted-key and bare-identifier-key entries, e.g.
    # `"skip-trivial": "skipped-trivial",` and `superseded: "superseded",`.
    return dict(re.findall(r'^\s*"?([a-zA-Z-]+)"?:\s*"([a-z-]+)",?\s*$', block.group(1), re.M))


def valid_lane_event_reasons() -> set[str]:
    text = WORKER_INDEX.read_text(encoding="utf-8")
    block = re.search(r"const VALID_LANE_EVENT_REASONS = new Set\(\[(.*?)\n\]\);", text, re.S)
    if not block:
        print("::error::VALID_LANE_EVENT_REASONS not found in worker/index.js")
        sys.exit(1)
    return set(re.findall(r'"([a-z-]+)"', block.group(1)))


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

    # worker/index.js's LANE_REASON_TO_VERDICT_KIND (#176): a lane event with no
    # usage_records row still needs a verdict kind the workflow emits and the
    # dashboard's VERDICT_KIND_MAP already knows, and a key that is a real reason.
    lane_map = lane_reason_to_verdict_kind()
    lane_reasons = valid_lane_event_reasons()
    verdict_kind_map_keys = mapped_kinds("VERDICT_KIND_MAP")

    bad_values = sorted(v for v in lane_map.values() if v and v not in emitted)
    if bad_values:
        fails.append(
            "LANE_REASON_TO_VERDICT_KIND maps to a kind the workflow never emits: "
            f"{', '.join(bad_values)}"
        )

    bad_values_dashboard = sorted(v for v in lane_map.values() if v and v not in verdict_kind_map_keys)
    if bad_values_dashboard:
        fails.append(
            "LANE_REASON_TO_VERDICT_KIND maps to a kind absent from the dashboard's "
            f"VERDICT_KIND_MAP: {', '.join(bad_values_dashboard)}"
        )

    bad_keys = sorted(k for k in lane_map.keys() if k not in lane_reasons)
    if bad_keys:
        fails.append(
            "LANE_REASON_TO_VERDICT_KIND has a key that is not a VALID_LANE_EVENT_REASONS "
            f"reason: {', '.join(bad_keys)}"
        )

    print(f"{len(emitted)} kind(s) emitted, {len(known)} known to the dashboard")
    print(f"{len(lane_map)} lane_events reason(s) mapped in worker/index.js")
    if fails:
        for f in fails:
            print(f"::error::Verdict kind drift: {f}")
        sys.exit(1)
    print("all verdict kinds are emitted, declared, mapped and bucketed")


if __name__ == "__main__":
    main()
