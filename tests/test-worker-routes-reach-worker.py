"""Every route worker/index.js answers must be listed in run_worker_first.

Static assets answer any path run_worker_first does not list, so a route missing from it is a
405 or the SPA shell in production while every unit test passes (#176). GET routes count too:
a long-poll GET /runner/lease answered by assets would fail live (#184).
"""
import pathlib
import re
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]
WRANGLER = ROOT / "worker" / "wrangler.toml"
INDEX_JS = ROOT / "worker" / "index.js"

# Routes the Worker must own before their handlers exist: the webhook is #184 bullet 4.
REQUIRED_PATTERNS = ["/webhook/github", "/runner/*"]
# A parser regression that finds nothing would pass the coverage check vacuously.
MUST_FIND = [("GET", "/api/summary"), ("GET", "/runner/lease"), ("POST", "/webhook/github")]


def run_worker_first():
    config = tomllib.loads(WRANGLER.read_text())
    return config.get("assets", {}).get("run_worker_first", [])


def enclosing_if_condition(content, pos):
    """The condition of the nearest `if (` before pos, if pos lies inside it; else None."""
    if_pos = content.rfind("if (", 0, pos)
    if if_pos == -1:
        return None
    start = if_pos + len("if ")
    depth = 0
    for i in range(start, len(content)):
        if content[i] == "(":
            depth += 1
        elif content[i] == ")":
            depth -= 1
            if depth == 0:
                return content[start:i + 1] if start < pos < i else None
    return None


def find_routes(content):
    """{route: {method, ...}} from every `method === "GET"|"POST"|"DELETE"` in an if condition."""
    routes = {}
    for m in re.finditer(r'method\s*===\s*["\'](GET|POST|DELETE)["\']', content):
        cond = enclosing_if_condition(content, m.start())
        if cond is None:
            continue
        found = re.findall(r'pathname\s*===\s*["\']([^"\']+)["\']', cond)
        prefixes = re.findall(r'pathname\.startsWith\s*\(\s*["\']([^"\']+)["\']\s*\)', cond)
        found += [p.rstrip("/") or "/" for p in prefixes]
        for route in found:
            routes.setdefault(route, set()).add(m.group(1))
    return routes


def covered(route, patterns):
    for pattern in patterns:
        if pattern == route:
            return True
        if pattern.endswith("/*"):
            base = pattern[:-2]
            if route == base or route.startswith(base + "/"):
                return True
    return False


def main():
    patterns = run_worker_first()
    print(f"Configured run_worker_first routes: {patterns}")
    routes = find_routes(INDEX_JS.read_text())
    for route in sorted(routes):
        print(f"  {','.join(sorted(routes[route])):<12} {route}")

    failed = False
    for method, route in MUST_FIND:
        if method not in routes.get(route, set()):
            print(f"ERROR: the parser did not find {method} {route}; it has regressed.")
            failed = True

    for pattern in REQUIRED_PATTERNS:
        if pattern not in patterns:
            print(f"ERROR: run_worker_first must list '{pattern}'.")
            failed = True

    for route in sorted(routes):
        if not covered(route, patterns):
            methods = ",".join(sorted(routes[route]))
            print(f"ERROR: {methods} route '{route}' is not covered by any run_worker_first pattern!")
            failed = True

    if failed:
        sys.exit(1)
    print("SUCCESS: All routes are covered.")


if __name__ == "__main__":
    main()
