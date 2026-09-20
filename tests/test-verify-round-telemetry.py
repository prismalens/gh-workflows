#!/usr/bin/env python3
"""The verify job writes telemetry too, without reopening the OIDC wall.

#87 cause 2: the verify job ran claude-code-action but produced no telemetry
record, so every verify-* round and its cost went unaccounted. The fix
(#176) gives the verify job its own call into the round-telemetry composite
action -- the same one the review job calls -- with round_type: verify. That
must never come at the cost of the two invariants gh-workflows#20 already
enforces: the verify job holds no id-token permission, and its tripwire step
(which would catch OIDC leaking back in) runs before anything else.

Run: python3 tests/test-verify-round-telemetry.py
"""
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
TRIPWIRE_STEP = "Tripwire — no OIDC request environment"
ROUND_TELEMETRY_USES = "prismalens/gh-workflows/.github/actions/round-telemetry@main"


def main() -> int:
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    verify = wf["jobs"].get("verify")
    if not verify:
        print("::error::no 'verify' job in the workflow")
        return 1

    fails = []
    steps = verify.get("steps") or []

    # 1. The tripwire step is still first.
    if not steps or steps[0].get("name") != TRIPWIRE_STEP:
        fails.append(
            f"the verify job's first step is {steps[0].get('name') if steps else None!r}, "
            f"expected {TRIPWIRE_STEP!r}"
        )
    else:
        print(f"  ok    {TRIPWIRE_STEP!r} is still the verify job's first step")

    # 2. No id-token permission on the verify job.
    permissions = verify.get("permissions") or {}
    if permissions.get("id-token"):
        fails.append(f"the verify job's permissions grant id-token: {permissions.get('id-token')!r}")
    else:
        print("  ok    the verify job has no id-token permission")

    # 3. A round-telemetry step exists, calling the same composite action as
    #    the review job, with round_type: verify.
    telemetry_steps = [s for s in steps if s.get("uses") == ROUND_TELEMETRY_USES]
    if len(telemetry_steps) != 1:
        fails.append(
            f"expected exactly one step using {ROUND_TELEMETRY_USES!r} in the verify job, "
            f"found {len(telemetry_steps)}"
        )
    else:
        step = telemetry_steps[0]
        with_block = step.get("with") or {}
        if with_block.get("round_type") != "verify":
            fails.append(f"round-telemetry step's round_type is {with_block.get('round_type')!r}, expected 'verify'")
        else:
            print("  ok    the verify job calls round-telemetry with round_type: verify")

        if "execution_file" not in with_block:
            fails.append("round-telemetry step in the verify job carries no execution_file input")
        else:
            print("  ok    the verify job's round-telemetry step passes execution_file")

        # The verify job's own claude step output feeds it, not the review job's.
        exec_file_src = with_block.get("execution_file", "")
        if "claude-verify" not in exec_file_src:
            fails.append(
                f"execution_file does not reference steps.claude-verify.outputs.execution_file: {exec_file_src!r}"
            )
        else:
            print("  ok    execution_file comes from steps.claude-verify, not the review job")

    # 4. The verify job exposes telemetry_record as a job output, for the
    #    telemetry job to consume.
    outputs = verify.get("outputs") or {}
    if "telemetry_record" not in outputs:
        fails.append("the verify job has no 'telemetry_record' output")
    else:
        print("  ok    the verify job exposes a telemetry_record output")

    # 5. The telemetry job's needs/if now cover both review and verify.
    telemetry = wf["jobs"].get("telemetry") or {}
    needs = telemetry.get("needs") or []
    if "verify" not in needs:
        fails.append(f"the telemetry job's needs does not include 'verify': {needs}")
    else:
        print("  ok    the telemetry job needs the verify job")

    telemetry_if = telemetry.get("if", "")
    if "needs.verify.outputs.telemetry_record" not in telemetry_if:
        fails.append(f"the telemetry job's if condition does not reference needs.verify.outputs.telemetry_record: {telemetry_if!r}")
    else:
        print("  ok    the telemetry job's if condition covers a verify-only record")

    print(f"\n{len(fails)} failure(s)")
    if fails:
        for f in fails:
            print(f"  - {f}")
        return 1
    print("all verify round-telemetry checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
