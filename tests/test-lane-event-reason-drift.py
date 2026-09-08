#!/usr/bin/env python3
"""Every lane-event reason the workflow emits must be accepted by the worker and known
to the dashboard.

The lane-event job (`claude-code-review.yml`) assigns a `reason` to `$reason` in a shell
`if`/`elif` chain, one literal per branch. `VALID_LANE_EVENT_REASONS` in `worker/index.js`
is the ingest-time allowlist: a reason the workflow emits that the worker rejects is a
400, and the event is silently lost rather than stored. `LANE_EVENT_REASONS` in
`dashboard/src/features/failures/failures.ts` is the render-time allowlist: a reason the
worker stores that the dashboard has never heard of is a row that can never be
populated. Both directions are the same failure this repository exists to catch: a
reason the workflow can emit but the rest of the pipeline cannot carry.

This had already happened once. `draft`, `skip-trivial` and `superseded` were emitted by
the workflow and known to the dashboard, but `VALID_LANE_EVENT_REASONS` accepted only six
of the nine reasons, 400-rejecting all three. `skip-trivial` and `superseded` became
reachable through gh-workflows#154; `draft` predates it. Story: gh-workflows#154.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/claude-code-review.yml"
WORKER_INDEX = ROOT / "worker/index.js"
FAILURES_TS = ROOT / "dashboard/src/features/failures/failures.ts"


def emitted_reasons() -> set[str]:
    text = WORKFLOW.read_text(encoding="utf-8")
    found = set(re.findall(r'reason="([a-z-]+)"', text))
    # The initialiser (`reason=""`), not a reason.
    found.discard("")
    return found


def worker_reasons() -> set[str]:
    text = WORKER_INDEX.read_text(encoding="utf-8")
    block = re.search(
        r"VALID_LANE_EVENT_REASONS\s*=\s*new Set\(\[(.*?)\]\)", text, re.S
    )
    if not block:
        print("::error::VALID_LANE_EVENT_REASONS not found in worker/index.js")
        sys.exit(1)
    return set(re.findall(r'"([a-z-]+)"', block.group(1)))


def dashboard_reasons() -> set[str]:
    text = FAILURES_TS.read_text(encoding="utf-8")
    block = re.search(
        r"export const LANE_EVENT_REASONS = \[(.*?)\] as const;", text, re.S
    )
    if not block:
        print("::error::LANE_EVENT_REASONS not found in dashboard/src/features/failures/failures.ts")
        sys.exit(1)
    return set(re.findall(r'"([a-z-]+)"', block.group(1)))


def main() -> None:
    emitted = emitted_reasons()
    worker = worker_reasons()
    dashboard = dashboard_reasons()
    fails = []

    missing_from_worker = sorted(emitted - worker)
    if missing_from_worker:
        fails.append(
            "emitted by the workflow but rejected by the worker's "
            f"VALID_LANE_EVENT_REASONS (a silent 400): {', '.join(missing_from_worker)}"
        )

    missing_from_dashboard = sorted(emitted - dashboard)
    if missing_from_dashboard:
        fails.append(
            "emitted by the workflow but unknown to the dashboard's "
            f"LANE_EVENT_REASONS (a row that can never populate): {', '.join(missing_from_dashboard)}"
        )

    stale_in_worker = sorted(worker - emitted)
    if stale_in_worker:
        fails.append(
            "accepted by the worker but never emitted by the workflow "
            f"(dead allowlist entries): {', '.join(stale_in_worker)}"
        )

    stale_in_dashboard = sorted(dashboard - emitted)
    if stale_in_dashboard:
        fails.append(
            "known to the dashboard but never emitted by the workflow "
            f"(dead dashboard entries): {', '.join(stale_in_dashboard)}"
        )

    print(
        f"{len(emitted)} reason(s) emitted, {len(worker)} accepted by the worker, "
        f"{len(dashboard)} known to the dashboard"
    )
    if fails:
        for f in fails:
            print(f"::error::Lane event reason drift: {f}")
        sys.exit(1)
    print("all lane event reasons are emitted, accepted and displayable, in agreement")


if __name__ == "__main__":
    main()
