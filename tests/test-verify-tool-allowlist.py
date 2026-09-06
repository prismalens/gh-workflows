#!/usr/bin/env python3
"""The verify agent's tool allowlist is a security boundary, so pin it.

Agent mode resolves tools ONLY from `--allowed-tools`, which makes that one string the
whole of what the verify agent can do. The job also holds a read-only `GITHUB_TOKEN` and
no `id-token: write`, but neither of those stops a tool that writes through `gh`.

`gh pr view` was added by the operator ruling on #123: without PR metadata the verify
agent cannot check a whole class of finding the review agent is allowed to raise, and
those threads resolve as `cannot_verify` forever. `gh api` is deliberately absent because
it can POST.

Fails if the allowlist changes in either direction, so a widening is a decision rather
than a diff nobody read.
"""

import pathlib
import re
import sys

WORKFLOW = pathlib.Path(__file__).resolve().parents[1] / ".github/workflows/claude-code-review.yml"

EXPECTED = {
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Bash(gh pr diff:*)",
    "Bash(gh pr view:*)",
}

# Anything here in the verify agent's allowlist is a hole. `gh api` and `gh pr comment`
# write; Task spawns agents that do not inherit this list; Write and Edit are obvious.
BANNED_SUBSTRINGS = [
    "gh api",
    "gh pr comment",
    "gh pr review",
    "gh pr merge",
    "gh issue comment",
    "Task",
    "Write",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "mcp__",
]


def verify_allowlist(text: str) -> str:
    """The --allowed-tools string belonging to the verify job, not the review job."""
    verify = text.split("\n  verify:", 1)
    if len(verify) != 2:
        raise AssertionError("could not locate the `verify:` job in the workflow")
    body = verify[1].split("\n  mutate:", 1)[0]

    matches = re.findall(r'--allowed-tools\s*\n\s*"([^"]*)"', body)
    if len(matches) != 1:
        raise AssertionError(
            f"expected exactly one --allowed-tools in the verify job, found {len(matches)}"
        )
    return matches[0]


def main() -> int:
    text = WORKFLOW.read_text(encoding="utf-8")
    fails = []

    try:
        allowlist = verify_allowlist(text)
    except AssertionError as e:
        print(f"  FAIL  {e}")
        print("\n1 FAILED")
        return 1

    tools = {t.strip() for t in allowlist.split(",") if t.strip()}

    # Bash(...) entries contain a comma only if someone writes one; split on "," is safe
    # for the current shapes and this reassembles them if it ever is not.
    if any(t.startswith("Bash(") and not t.endswith(")") for t in tools):
        tools = set(re.findall(r"Bash\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*", allowlist))

    if tools == EXPECTED:
        print(f"  ok    verify allowlist is exactly the {len(EXPECTED)} pinned tools")
    else:
        added = sorted(tools - EXPECTED)
        removed = sorted(EXPECTED - tools)
        fails.append(f"verify allowlist changed: added {added}, removed {removed}")
        print(f"  FAIL  verify allowlist changed: added {added}, removed {removed}")

    hits = [b for b in BANNED_SUBSTRINGS if b in allowlist]
    if hits:
        fails.append(f"verify allowlist contains write-capable or agent-spawning tools: {hits}")
        print(f"  FAIL  verify allowlist contains {hits}")
    else:
        print("  ok    verify allowlist contains nothing that writes or spawns agents")

    print(f"\n{len(fails)} failure(s)")
    if fails:
        for f in fails:
            print(f"  - {f}")
        return 1
    print("all verify tool allowlist checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
