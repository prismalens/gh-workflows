#!/usr/bin/env python3
"""Behavioural tests for the pin-bump reusable workflow (#250).

Extracts the real step scripts out of pin-bump.yml and runs them against a fake npm and a
local git remote, verifying:
1. The newest stable release that has soaked is picked; younger and prerelease ones are not.
2. No soaked release newer than the pin: version is empty.
3. The pin is found in devDependencies by package name, and its ^ prefix is kept.
4. An explicit JSON-array pin-key reaches a nested pin whose package name holds a dot.
5. A missing pin fails.
6. Moving the pin keeps the file's tab indent, runs the probe with PIN_VERSION, records its
   exit status and names the branch.
7. A branch that already exists on the remote skips the bump.

Run: python3 tests/test-pin-bump.py
"""
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = yaml.safe_load((ROOT / ".github/workflows/pin-bump.yml").read_text())
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _bash_step import run_step, write_fake  # noqa: E402


def step(name):
    for s in WF["jobs"]["bump"]["steps"]:
        if s.get("name") == name:
            return s["run"]
    sys.exit(f"step {name!r} not in pin-bump.yml")


PICK = step("Pick the newest soaked release")
MOVE = step("Move the pin and probe it")
NOW = datetime.datetime.now(datetime.timezone.utc)


def ago(days):
    return (NOW - datetime.timedelta(days=days)).isoformat().replace("+00:00", "Z")


TIMES = {"created": ago(400), "modified": ago(1), "1.0.0": ago(60), "1.1.0": ago(10),
         "1.2.0-beta.1": ago(9), "1.2.0": ago(2)}

failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(f"{name}: {detail}")


def outputs(path):
    return dict(l.split("=", 1) for l in path.read_text().splitlines() if "=" in l)


def pick(pins, package="pkg", key="", times=TIMES, soak="7"):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "bin").mkdir()
        (t / "times").write_text(json.dumps(times))
        write_fake(t / "bin", "npm", f'cat "{t}/times"\n')
        (t / "pins.json").write_text(json.dumps(pins))
        (t / "out").touch()
        r = run_step(PICK, {"PACKAGE": package, "PIN_PATH": str(t / "pins.json"), "PIN_KEY": key,
                            "SOAK_DAYS": soak, "RUNNER_TEMP": td, "GITHUB_OUTPUT": str(t / "out")}, t / "bin")
        return r, outputs(t / "out")


r, out = pick({"dependencies": {"pkg": "1.0.0"}})
check("1 newest soaked release", r.returncode == 0 and out.get("version") == "1.1.0" and out.get("current") == "1.0.0"
      and out.get("published") == TIMES["1.1.0"], (out, r.stderr))

r, out = pick({"dependencies": {"pkg": "1.1.0"}})
check("2 nothing newer soaked", r.returncode == 0 and out.get("version") == "", (out, r.stderr))

r, out = pick({"devDependencies": {"pkg": "^1.0.0"}})
check("3 found in devDependencies, prefix kept", out.get("prefix") == "^"
      and json.loads(out.get("key", "null")) == ["devDependencies", "pkg"] and out.get("version") == "1.1.0",
      (out, r.stderr))

r, out = pick({"engines": {"socket.io": "1.0.0"}}, package="socket.io", key='["engines","socket.io"]')
check("4 explicit key with a dotted name", r.returncode == 0 and out.get("version") == "1.1.0", (out, r.stderr))

r, out = pick({"dependencies": {}})
check("5 missing pin fails", r.returncode != 0 and "no pin for pkg" in r.stderr, r.stderr)


def git(*a, cwd):
    subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)


def move(existing_branch=False, probe='echo "probing $PIN_VERSION"; exit 4'):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        git("init", "-q", "--bare", "remote.git", cwd=td)
        work = t / "work"
        work.mkdir()
        git("init", "-q", cwd=work)
        (work / "package.json").write_text('{\n\t"dependencies": {\n\t\t"@openai/codex": "^1.0.0"\n\t}\n}\n')
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init", cwd=work)
        git("remote", "add", "origin", str(t / "remote.git"), cwd=work)
        if existing_branch:
            git("push", "-q", "origin", "HEAD:refs/heads/pin-bump/openai-codex-1.1.0", cwd=work)
        (t / "out").touch()
        r = run_step(MOVE, {"PACKAGE": "@openai/codex", "PIN_PATH": "package.json",
                            "PIN_KEY": '["dependencies","@openai/codex"]', "PIN_VERSION": "1.1.0", "PREFIX": "^",
                            "PROBE": probe, "RUNNER_TEMP": td, "GITHUB_OUTPUT": str(t / "out")}, cwd=work)
        log = (t / "probe.log").read_text() if (t / "probe.log").exists() else ""
        return r, outputs(t / "out"), (work / "package.json").read_text(), log


r, out, pkg, log = move()
check("6 pin moved, tab indent kept", r.returncode == 0
      and pkg == '{\n\t"dependencies": {\n\t\t"@openai/codex": "^1.1.0"\n\t}\n}\n', (pkg, r.stderr))
check("6 probe ran with PIN_VERSION, status recorded", "probing 1.1.0" in log and out.get("status") == "4"
      and out.get("branch") == "pin-bump/openai-codex-1.1.0", (out, log))

r, out, pkg, log = move(existing_branch=True)
check("7 existing branch skips", r.returncode == 0 and out.get("skip") == "true" and log == ""
      and '"^1.0.0"' in pkg, (out, r.stdout, r.stderr))

if failures:
    sys.exit("\n".join(failures))
print("all pin-bump checks passed")
