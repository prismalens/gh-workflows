#!/usr/bin/env python3
"""Behavioural tests for actions/wait-npm-tarball (#250).

Runs the action's real step script against fake npm and curl, verifying:
1. Version listed and tarball serving on the first poll: exit 0, `tarball=` output.
2. Packument lists the version but the tarball 404s twice: waits, then succeeds.
3. Never served by the deadline: exit 1 with an error naming package and version.

Run: python3 tests/test-wait-npm-tarball.py
"""
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _composite_action import extract_composite_step_script  # noqa: E402
from _bash_step import run_step, write_fake  # noqa: E402

SCRIPT = extract_composite_step_script(ROOT / "actions/wait-npm-tarball/action.yml")
URL = "https://registry.npmjs.org/pkg/-/pkg-1.2.3.tgz"


def run(curl_fails, timeout_minutes="1"):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "bin").mkdir()
        write_fake(t / "bin", "npm", f'echo "{URL}"\n')
        write_fake(t / "bin", "curl", f"""n=$(( $(cat "{t}/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "{t}/n"
[ "$n" -gt {curl_fails} ]
""")
        (t / "out").touch()
        r = run_step(SCRIPT, {"PACKAGE": "pkg", "VERSION": "1.2.3", "TIMEOUT_MINUTES": timeout_minutes,
                              "INTERVAL": "0", "GITHUB_OUTPUT": str(t / "out")}, t / "bin")
        return r, (t / "out").read_text(), int((t / "n").read_text())


failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(f"{name}: {detail}")


r, out, n = run(0)
check("1 serves at once", r.returncode == 0 and f"tarball={URL}" in out and n == 1, r.stdout + r.stderr)

r, out, n = run(2)
check("2 waits for the tarball", r.returncode == 0 and n == 3 and f"tarball={URL}" in out, r.stdout + r.stderr)

r, out, n = run(10**6, timeout_minutes="0")
check("3 deadline fails", r.returncode == 1 and "::error::pkg@1.2.3" in r.stdout and out == "", r.stdout + r.stderr)

if failures:
    sys.exit("\n".join(failures))
print("all wait-npm-tarball checks passed")
