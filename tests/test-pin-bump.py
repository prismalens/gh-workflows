#!/usr/bin/env python3
"""Behavioural tests for the pin-bump reusable workflow (#250).

Extracts the real step scripts out of pin-bump.yml and runs them against a fake npm, a fake gh
and a local git remote, verifying:
1. The newest stable release that has soaked is planned; younger and prerelease ones are not.
2. No soaked release newer than the pin: nothing is planned.
3. The pin is found in devDependencies by package name, and its ^ prefix is kept.
4. An explicit JSON-array pin-key reaches a nested pin whose package name holds a dot.
5. A missing pin fails.
6. Several pins are planned in one run, each against its own release times.
7. Every pin moves with its file's tab indent kept, and the probe sees PIN_PACKAGE and PIN_VERSION.
8. A failed probe puts only its pin back, before the next probe reads the file.
9. The title names only the pins that moved; the body lists the held-back one.
10. No branch yet: the commit is pushed and a PR opened.
11. The branch already carries these pins: nothing is pushed, the open PR is refreshed.
12. The branch holds someone else's commit: nothing is pushed or edited.
13. Nothing to move and nothing held: the open PR is closed.
14. Nothing moved because a probe failed: the open PR stays.

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


PICK = step("Pick the newest soaked release of every pin")
PROBE = step("Move each pin and probe it")
PR = step("Open or refresh the pull request")
NOW = datetime.datetime.now(datetime.timezone.utc)
BOT = "41898+github-actions[bot]@users.noreply.github.com"


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


def pick(files, pins, times=None, soak="7"):
    times = times or {}
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "bin").mkdir()
        for name, data in files.items():
            (t / name).write_text(json.dumps(data))
        for i, p in enumerate(pins):
            (t / f"times-{i}").write_text(json.dumps(times.get(p["package"], TIMES)))
        cases = "".join(f'  "{p["package"]}") cat "{t}/times-{i}" ;;\n' for i, p in enumerate(pins))
        write_fake(t / "bin", "npm", f'case "$2" in\n{cases}esac\n')
        (t / "out").touch()
        r = run_step(PICK, {"PINS": json.dumps(pins), "SOAK_DAYS": soak, "RUNNER_TEMP": td,
                            "GITHUB_OUTPUT": str(t / "out")}, t / "bin", cwd=td)
        plan = json.loads((t / "plan.json").read_text()) if (t / "plan.json").exists() else None
        return r, outputs(t / "out"), plan


r, out, plan = pick({"p.json": {"dependencies": {"pkg": "1.0.0"}}}, [{"package": "pkg", "pin-path": "p.json"}])
check("1 newest soaked release", r.returncode == 0 and out.get("count") == "1" and plan[0]["version"] == "1.1.0"
      and plan[0]["current"] == "1.0.0" and plan[0]["published"] == TIMES["1.1.0"], (plan, r.stderr))

r, out, plan = pick({"p.json": {"dependencies": {"pkg": "1.1.0"}}}, [{"package": "pkg", "pin-path": "p.json"}])
check("2 nothing newer soaked", r.returncode == 0 and out.get("count") == "0" and plan == [], (plan, r.stderr))

r, out, plan = pick({"p.json": {"devDependencies": {"pkg": "^1.0.0"}}}, [{"package": "pkg", "pin-path": "p.json"}])
check("3 found in devDependencies, prefix kept", plan and plan[0]["prefix"] == "^"
      and plan[0]["key"] == ["devDependencies", "pkg"] and plan[0]["version"] == "1.1.0", (plan, r.stderr))

r, out, plan = pick({"p.json": {"engines": {"socket.io": "1.0.0"}}},
                    [{"package": "socket.io", "pin-path": "p.json", "pin-key": '["engines","socket.io"]'}])
check("4 explicit key with a dotted name", r.returncode == 0 and plan[0]["version"] == "1.1.0", (plan, r.stderr))

r, out, plan = pick({"p.json": {"dependencies": {}}}, [{"package": "pkg", "pin-path": "p.json"}])
check("5 missing pin fails", r.returncode != 0 and "no pin for pkg" in r.stderr, r.stderr)

r, out, plan = pick({"p.json": {"dependencies": {"a": "1.0.0", "b": "2.0.0"}}},
                    [{"package": "a", "pin-path": "p.json"}, {"package": "b", "pin-path": "p.json"}],
                    times={"b": {"2.0.0": ago(30), "2.1.0": ago(8)}})
check("6 several pins, each on its own times", out.get("count") == "2"
      and [(p["package"], p["version"]) for p in plan or []] == [("a", "1.1.0"), ("b", "2.1.0")], (plan, r.stderr))


def probe(probe_cmd):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "package.json").write_text('{\n\t"dependencies": {\n\t\t"a": "^1.0.0",\n\t\t"b": "2.0.0"\n\t}\n}\n')
        plan = [{"package": "a", "pinPath": "package.json", "key": ["dependencies", "a"], "prefix": "^",
                 "current": "1.0.0", "version": "1.1.0", "published": "2026-01-01T00:00:00Z"},
                {"package": "b", "pinPath": "package.json", "key": ["dependencies", "b"], "prefix": "",
                 "current": "2.0.0", "version": "2.1.0", "published": "2026-01-02T00:00:00Z"}]
        (t / "plan.json").write_text(json.dumps(plan))
        (t / "out").touch()
        r = run_step(PROBE, {"PROBE": probe_cmd, "SOAK_DAYS": "3", "BRANCH": "pin-bump/agents", "RUNNER_TEMP": td,
                             "GITHUB_OUTPUT": str(t / "out")}, cwd=td)
        moved = json.loads((t / "moved.json").read_text()) if (t / "moved.json").exists() else None
        body = (t / "body.md").read_text() if (t / "body.md").exists() else ""
        return r, outputs(t / "out"), (t / "package.json").read_text(), moved, body


r, out, pkg, moved, body = probe('echo "probing $PIN_PACKAGE $PIN_VERSION"')
check("7 every pin moved, tab indent kept", r.returncode == 0
      and pkg == '{\n\t"dependencies": {\n\t\t"a": "^1.1.0",\n\t\t"b": "2.1.0"\n\t}\n}\n', (pkg, r.stderr))
check("7 probe saw PIN_PACKAGE and PIN_VERSION", "probing a 1.1.0" in body and "probing b 2.1.0" in body
      and out.get("moved") == "2" and out.get("held") == "0", (out, body))

# a fails; b's probe must already read a's pin back at ^1.0.0.
r, out, pkg, moved, body = probe('[ "$PIN_PACKAGE" = a ] && exit 3; grep -o \'"a": "[^"]*"\' package.json')
check("8 failed probe puts only its pin back first", r.returncode == 0
      and '"a": "^1.0.0"' in pkg and '"b": "2.1.0"' in pkg and '"a": "^1.0.0"' in body, (pkg, body, r.stderr))
check("9 title names the moved pin, body the held one", out.get("title") == "build(deps): pin b 2.1.0"
      and out.get("moved") == "1" and out.get("held") == "1" and "failed (exit 3), held back" in body
      and [m["package"] for m in moved] == ["b"] and "::warning::the probe failed on a@1.1.0" in r.stdout,
      (out, body, r.stdout))


def git(*a, cwd):
    return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def pr_step(moved="1", held="0", branch=None, open_pr=""):
    """branch: None (absent), "same" (bot commit, same pins), "other" (someone else's commit)."""
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        git("init", "-q", "--bare", "-b", "main", "remote.git", cwd=td)
        work = t / "work"
        work.mkdir()
        git("init", "-q", "-b", "main", cwd=work)
        (work / "p.json").write_text('{"dependencies": {"a": "1.0.0"}}\n')
        git("add", "-A", cwd=work)
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init", cwd=work)
        git("remote", "add", "origin", str(t / "remote.git"), cwd=work)
        git("push", "-q", "origin", "main", cwd=work)
        if branch:
            git("switch", "-q", "-c", "side", cwd=work)
            (work / "p.json").write_text('{"dependencies": {"a": "1.1.0"}}\n')
            email = BOT if branch == "same" else "someone@example.com"
            git("-c", "user.name=x", "-c", f"user.email={email}", "commit", "-qam", "bump", cwd=work)
            git("push", "-q", "origin", "side:refs/heads/pin-bump/agents", cwd=work)
            git("switch", "-q", "main", cwd=work)
            git("branch", "-qD", "side", cwd=work)
        if moved != "0":
            (work / "p.json").write_text('{"dependencies": {"a": "1.1.0"}}\n')
        (t / "bin").mkdir()
        write_fake(t / "bin", "gh", f'echo "$*" >> "{t}/gh.log"\n'
                   f'[ "$1 $2" = "pr list" ] && echo "{open_pr}"\nexit 0\n')
        (t / "body.md").write_text("body\n")
        r = run_step(PR, {"GH_TOKEN": "x", "BRANCH": "pin-bump/agents", "MOVED": moved, "HELD": held,
                          "TITLE": "build(deps): pin a 1.1.0", "RUNNER_TEMP": td,
                          "PINS": json.dumps([{"package": "a", "pin-path": "p.json"}])}, t / "bin", cwd=work)
        gh = (t / "gh.log").read_text() if (t / "gh.log").exists() else ""
        tip = subprocess.run(["git", "rev-parse", "pin-bump/agents"], cwd=t / "remote.git",
                             capture_output=True, text=True).stdout.strip()
        return r, gh, tip, git("rev-parse", "HEAD", cwd=work)


r, gh, tip, head = pr_step()
check("10 no branch: pushed and opened", r.returncode == 0 and tip == head and "pr create" in gh, (gh, r.stderr))

r, gh, tip, head = pr_step(branch="same", open_pr="7")
check("11 same pins: not pushed, PR refreshed", r.returncode == 0 and tip != head and "pr edit 7" in gh
      and "already carries these pins" in r.stdout, (gh, r.stdout, r.stderr))

r, gh, tip, head = pr_step(branch="other", open_pr="7")
check("12 someone else's commit: left alone", r.returncode == 0 and tip != head and "pr edit" not in gh
      and "pr create" not in gh and "someone else's commits" in r.stdout, (gh, r.stdout, r.stderr))

r, gh, tip, head = pr_step(moved="0", branch="same", open_pr="7")
check("13 nothing to move: PR closed", r.returncode == 0 and "pr close 7 --delete-branch" in gh, (gh, r.stderr))

r, gh, tip, head = pr_step(moved="0", held="1", branch="same", open_pr="7")
check("14 only held pins: PR stays", r.returncode == 0 and "pr close" not in gh, (gh, r.stderr))

if failures:
    sys.exit("\n".join(failures))
print("all pin-bump checks passed")
