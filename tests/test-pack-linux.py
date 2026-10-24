#!/usr/bin/env python3
"""Behavioural tests for actions/pack-linux (#250).

Runs the action's real pack step script, verifying:
1. A runner that is not Linux is refused before anything runs.
2. Install, test and pack run in order; SHA256SUMS lists every tarball, sorted, and both
   outputs are written.
3. An empty test input skips the test command.
4. A pack command that writes no .tgz fails.
5. A failing test command fails the step before packing.

Run: python3 tests/test-pack-linux.py
"""
import hashlib
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _composite_action import extract_composite_step_script  # noqa: E402
from _bash_step import run_step  # noqa: E402

SCRIPT = extract_composite_step_script(ROOT / "actions/pack-linux/action.yml", 1)
PACK = 'echo pack >> "$LOG"; printf b > "$PACK_DIR/b-1.0.0.tgz"; printf a > "$PACK_DIR/a-1.0.0.tgz"'


def run(os_name="Linux", test='echo test >> "$LOG"', pack=PACK):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "out").touch()
        r = run_step(SCRIPT, {"RUNNER_OS_NAME": os_name, "INSTALL": 'echo install >> "$LOG"', "TEST": test,
                              "PACK": pack, "PACK_DIR": str(t / "pack"), "LOG": str(t / "log"),
                              "GITHUB_OUTPUT": str(t / "out")}, cwd=td)
        log = (t / "log").read_text().split() if (t / "log").exists() else []
        sums = (t / "pack/SHA256SUMS").read_text() if (t / "pack/SHA256SUMS").exists() else ""
        return r, log, sums, (t / "out").read_text()


failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(f"{name}: {detail}")


r, log, _, _ = run(os_name="Windows")
check("1 non-Linux refused", r.returncode == 1 and log == [] and "only on Linux" in r.stdout, r.stdout + r.stderr)

r, log, sums, out = run()
want = "".join(f"{hashlib.sha256(c).hexdigest()}  {n}\n" for n, c in [("a-1.0.0.tgz", b"a"), ("b-1.0.0.tgz", b"b")])
check("2 order install, test, pack", r.returncode == 0 and log == ["install", "test", "pack"], r.stdout + r.stderr)
check("2 SHA256SUMS sorted and complete", sums == want, sums)
check("2 outputs written", "dir=" in out and "sha256sums<<SHA256SUMS_EOF\n" + want + "SHA256SUMS_EOF" in out, out)

r, log, _, _ = run(test="")
check("3 empty test skipped", r.returncode == 0 and log == ["install", "pack"], r.stdout + r.stderr)

r, _, _, out = run(pack="true")
check("4 no tarball fails", r.returncode == 1 and "wrote no .tgz" in r.stdout and "dir=" not in out, r.stdout + r.stderr)

r, log, _, _ = run(test="exit 3")
check("5 failing test stops before pack", r.returncode == 3 and log == ["install"], r.stdout + r.stderr)

if failures:
    sys.exit("\n".join(failures))
print("all pack-linux checks passed")
