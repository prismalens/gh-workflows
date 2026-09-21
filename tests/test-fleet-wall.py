#!/usr/bin/env python3
"""A fleet route never selects text.

The Console's Fleet altitude reads `GET /api/fleet/*`: aggregates that carry
counts and identifiers and never a name, a title or a body. The wall is in the
API, so it is checked on the Worker source: every `/api/fleet/` path dispatches
to a `handleFleet*` handler, and no such handler names a text column, not even
in a comment. Story: gh-workflows#185.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKER_INDEX = ROOT / "worker/index.js"

TEXT_COLUMNS = (
    "pr_title",
    "pr_author",
    "verdict_text",
    "header_raw",
    "body_excerpt",
    "raw_result",
    "diff_hunk",
)
ROUTE = re.compile(
    r'pathname\s*===\s*"(/api/fleet/[^"]*)"|pathname\.startsWith\(\s*"(/api/fleet/[^"]*)"\s*\)'
)
DISPATCH = re.compile(r"\breturn\s+(handle\w+)\(")
DISPATCH_WINDOW = 8
TOP_LEVEL = re.compile(r"^(async function |function |export )")
HANDLER = re.compile(r"^async function (handleFleet\w+)\(")


def fleet_handlers(lines: list[str]) -> dict[str, str]:
    bodies: dict[str, str] = {}
    for i, line in enumerate(lines):
        match = HANDLER.match(line)
        if not match:
            continue
        end = i + 1
        while end < len(lines) and not TOP_LEVEL.match(lines[end]):
            end += 1
        bodies[match.group(1)] = "\n".join(lines[i:end])
    return bodies


def main() -> int:
    lines = WORKER_INDEX.read_text(encoding="utf-8").splitlines()
    errors: list[str] = []

    routes = []
    for i, line in enumerate(lines):
        for match in ROUTE.finditer(line):
            routes.append((i, match.group(1) or match.group(2)))
    if not routes:
        print("::error::no /api/fleet/ route found in worker/index.js; this check would pass vacuously")
        return 1

    handlers = fleet_handlers(lines)
    for i, path in routes:
        target = None
        for later in lines[i + 1 : i + 1 + DISPATCH_WINDOW]:
            dispatch = DISPATCH.search(later)
            if dispatch:
                target = dispatch.group(1)
                break
        if target is None or not target.startswith("handleFleet"):
            errors.append(
                f"worker/index.js:{i + 1}: {path} must dispatch to a handleFleet* handler, found {target}"
            )
        elif target not in handlers:
            errors.append(f"worker/index.js:{i + 1}: {path} dispatches to {target}, which is not defined")

    for name, body in handlers.items():
        for column in TEXT_COLUMNS:
            if re.search(rf"\b{column}\b", body):
                errors.append(f"worker/index.js: {name} names the text column {column}")

    for error in errors:
        print(f"::error::{error}")
    if errors:
        return 1
    print(f"ok: {len(routes)} fleet route(s), {len(handlers)} fleet handler(s), no text column named")
    return 0


if __name__ == "__main__":
    sys.exit(main())
