#!/usr/bin/env python3
"""Behavioural tests for actions/setup-acp-engine (#250).

Runs the action's real step scripts against a fake npm, llmock and curl, verifying:
1. Each engine installs its engine and adapter at the given versions; opencode needs no adapter.
2. mock-fixtures adds @copilotkit/aimock at its pin.
3. An unknown engine, or a missing adapter-version, fails before installing.
4. claude-code exports ANTHROPIC_BASE_URL and a placeholder key.
5. codex gets a CODEX_HOME whose config.toml routes to aimock over the Responses wire.
6. opencode gets an OPENCODE_CONFIG whose provider points at aimock.
7. aimock starts strict on the given port; codex adds --responses-tools extended; the url is output.
8. mock-strict false drops --strict, and an aimock that never answers fails.

The end-to-end round through each real adapter runs in tests.yml's `acp-engines` job.

Run: python3 tests/test-setup-acp-engine.py
"""
import json
import pathlib
import sys
import tempfile
import time
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _composite_action import extract_composite_step_script  # noqa: E402
from _bash_step import run_step, write_fake  # noqa: E402

ACTION = ROOT / "actions/setup-acp-engine/action.yml"
INSTALL, CONFIGURE, START = (extract_composite_step_script(ACTION, i) for i in range(3))

failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(f"{name}: {detail}")


def install(engine, version="1.0.0", adapter="2.0.0", fixtures=""):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "bin").mkdir()
        write_fake(t / "bin", "npm", f'echo "$@" > "{t}/args"\n')
        r = run_step(INSTALL, {"ENGINE": engine, "VERSION": version, "ADAPTER_VERSION": adapter,
                               "MOCK_FIXTURES": fixtures, "AIMOCK_VERSION": "1.46.0"}, t / "bin")
        args = (t / "args").read_text().split() if (t / "args").exists() else None
        return r, args


r, args = install("claude-code")
check("1 claude-code packages", r.returncode == 0 and args[-2:] == ["@anthropic-ai/claude-code@1.0.0",
      "@agentclientprotocol/claude-agent-acp@2.0.0"], args)
r, args = install("codex")
check("1 codex packages", args[-2:] == ["@openai/codex@1.0.0", "@agentclientprotocol/codex-acp@2.0.0"], args)
r, args = install("opencode", adapter="")
check("1 opencode needs no adapter", r.returncode == 0 and args[-1] == "opencode-ai@1.0.0", args)
r, args = install("codex", fixtures="f.json")
check("2 aimock added", args[-1] == "@copilotkit/aimock@1.46.0", args)
r, args = install("gemini")
check("3 unknown engine", r.returncode == 1 and args is None and "unknown engine" in r.stdout, r.stdout)
r, args = install("codex", adapter="")
check("3 missing adapter-version", r.returncode == 1 and args is None and "adapter-version" in r.stdout, r.stdout)


def configure(engine):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "env").touch()
        r = run_step(CONFIGURE, {"ENGINE": engine, "MOCK_URL": "http://127.0.0.1:4010",
                                 "CONFIG_DIR": str(t / "cfg"), "GITHUB_ENV": str(t / "env")})
        env = dict(l.split("=", 1) for l in (t / "env").read_text().splitlines())
        files = {p.relative_to(t / "cfg").as_posix(): p.read_text() for p in (t / "cfg").rglob("*") if p.is_file()}
        return r, env, files


r, env, _ = configure("claude-code")
check("4 claude-code env", r.returncode == 0 and env.get("ANTHROPIC_BASE_URL") == "http://127.0.0.1:4010"
      and env.get("ANTHROPIC_API_KEY") == "aimock", env)

r, env, files = configure("codex")
cfg = tomllib.loads(files.get("codex-home/config.toml", ""))
check("5 codex config", r.returncode == 0 and env.get("CODEX_HOME", "").endswith("codex-home")
      and cfg.get("model_provider") == "aimock"
      and cfg["model_providers"]["aimock"] == {"name": "aimock", "base_url": "http://127.0.0.1:4010/v1",
                                               "wire_api": "responses", "env_key": "AIMOCK_KEY"}
      and env.get("AIMOCK_KEY") == "aimock", (env, cfg))

r, env, files = configure("opencode")
oc = json.loads(files.get("opencode.json", "{}"))
check("6 opencode config", r.returncode == 0 and env.get("OPENCODE_CONFIG", "").endswith("opencode.json")
      and oc["provider"]["aimock"]["options"]["baseURL"] == "http://127.0.0.1:4010/v1"
      and oc["model"] == "aimock/gpt-mock" and oc["$schema"] == "https://opencode.ai/config.json", oc)


def start(engine, strict="true", healthy=True):
    with tempfile.TemporaryDirectory() as td:
        t = pathlib.Path(td)
        (t / "bin").mkdir()
        (t / "out").touch()
        write_fake(t / "bin", "llmock", f'echo "$@" > "{t}/args"\n')
        write_fake(t / "bin", "curl", "true\n" if healthy else "false\n")
        write_fake(t / "bin", "sleep", "true\n")
        r = run_step(START, {"ENGINE": engine, "MOCK_FIXTURES": "fx.json", "MOCK_PORT": "4999",
                             "MOCK_STRICT": strict, "LOG": str(t / "log"), "GITHUB_OUTPUT": str(t / "out")},
                     t / "bin")
        for _ in range(50):
            if (t / "args").exists():
                break
            time.sleep(0.1)
        args = (t / "args").read_text().split() if (t / "args").exists() else []
        return r, args, (t / "out").read_text()


r, args, out = start("claude-code")
check("7 strict start", r.returncode == 0 and args[:4] == ["-f", "fx.json", "-p", "4999"] and "--strict" in args
      and "--responses-tools" not in args and "url=http://127.0.0.1:4999" in out, (args, out, r.stdout))
r, args, out = start("codex")
check("7 codex extended tools", "--responses-tools" in args and args[args.index("--responses-tools") + 1] == "extended",
      args)
r, args, out = start("opencode", strict="false")
check("8 not strict", r.returncode == 0 and "--strict" not in args, args)
r, args, out = start("opencode", healthy=False)
check("8 no health fails", r.returncode == 1 and "did not answer" in r.stdout and out == "", r.stdout)

if failures:
    sys.exit("\n".join(failures))
print("all setup-acp-engine checks passed")
