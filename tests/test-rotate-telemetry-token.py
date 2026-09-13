#!/usr/bin/env python3
"""Behavioural tests for scripts/rotate-telemetry-token.sh.

Runs the real script (nothing extracted), copied into a sandboxed <tmp>/scripts/
with a sibling <tmp>/worker/node_modules/.bin/wrangler, against stub `gh`,
`openssl` and `wrangler` binaries. Each stub logs its own argv and, where the real
command reads a secret on stdin, its stdin, to separate log files, so the tests can
prove the token never reaches an argv, stdout or stderr while still landing
everywhere it must. Stories: #156, gh-workflows#173 thread 4000816186 (the pinned
local wrangler binary, never an unpinned npx download).

Run: python3 tests/test-rotate-telemetry-token.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/rotate-telemetry-token.sh"
FAKE_TOKEN = "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef012345"

DEFAULT_REPOS = [
    "prismalens/prismalens",
    "prismalens/sreforge",
    "prismalens/gh-workflows",
    "Sumit1993/mage-memory",
]

GH_STUB_PY = r'''#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone

args = sys.argv[1:]


def log(path, line):
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


argv_log = os.environ.get("GH_ARGV_LOG", "")
stdin_log = os.environ.get("GH_STDIN_LOG", "")
seq_log = os.environ.get("SEQ_LOG", "")
cfg_path = os.environ.get("MOCK_CONFIG_FILE", "")
cfg = {}
if cfg_path and os.path.exists(cfg_path):
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

log(argv_log, json.dumps(args))


def flag(name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return None


if args[:2] == ["auth", "status"]:
    sys.exit(0 if cfg.get("auth_status_ok", True) else 1)

if args and args[0] == "api":
    endpoint = next((a for a in args[1:] if a.startswith("repos/")), "")
    jq_expr = flag("--jq")

    if endpoint.endswith("/actions/secrets/public-key"):
        repo = endpoint.split("repos/")[1].split("/actions/")[0]
        if cfg.get("public_key_ok", {}).get(repo, True):
            print("{}")
            sys.exit(0)
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)

    if endpoint.endswith("/actions/secrets/REVIEW_TELEMETRY_TOKEN"):
        repo = endpoint.split("repos/")[1].split("/actions/")[0]
        if not cfg.get("confirm_ok", {}).get(repo, True):
            sys.stderr.write("gh: Not Found (HTTP 404)\n")
            sys.exit(1)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if jq_expr == ".updated_at":
            print(ts)
        else:
            print(json.dumps({"updated_at": ts}))
        sys.exit(0)

    sys.stderr.write("gh stub: unhandled endpoint %r\n" % (endpoint,))
    sys.exit(1)

if args[:2] == ["secret", "set"]:
    repo = flag("--repo")
    token = sys.stdin.read()
    log(stdin_log, token)
    log(seq_log, "gh-secret-set %s" % repo)
    sys.exit(0 if cfg.get("secret_set_ok", {}).get(repo, True) else 1)

sys.stderr.write("gh stub: unhandled call %r\n" % (args,))
sys.exit(1)
'''

OPENSSL_STUB_PY = r'''#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]
argv_log = os.environ.get("OPENSSL_ARGV_LOG", "")
if argv_log:
    with open(argv_log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(args) + "\n")

cfg_path = os.environ.get("MOCK_CONFIG_FILE", "")
cfg = {}
if cfg_path and os.path.exists(cfg_path):
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

print(cfg.get("fake_token", "deadbeef0123456789abcdef0123456789abcdef0123456789abcdef012345"))
sys.exit(0)
'''

# Stubs worker/node_modules/.bin/wrangler directly -- the script no longer shells
# out through npx at all (CR #173, thread 4000816186: npx wrangler can download an
# unpinned Wrangler when worker/node_modules is absent, so the pinned local binary
# is invoked explicitly, and its absence fails preflight instead of falling back).
WRANGLER_STUB_PY = r'''#!/usr/bin/env python3
import json
import os
import sys

args = sys.argv[1:]


def log(path, line):
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


argv_log = os.environ.get("WRANGLER_ARGV_LOG", "")
stdin_log = os.environ.get("WRANGLER_STDIN_LOG", "")
seq_log = os.environ.get("SEQ_LOG", "")
cfg_path = os.environ.get("MOCK_CONFIG_FILE", "")
cfg = {}
if cfg_path and os.path.exists(cfg_path):
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

log(argv_log, json.dumps(args))

if args[:1] == ["whoami"]:
    sys.exit(0 if cfg.get("wrangler_whoami_ok", True) else 1)

if args[:2] == ["secret", "put"]:
    token = sys.stdin.read()
    log(stdin_log, token)
    log(seq_log, "wrangler-secret-put worker")
    sys.exit(0 if cfg.get("wrangler_secret_put_ok", True) else 1)

sys.stderr.write("wrangler stub: unhandled call %r\n" % (args,))
sys.exit(1)
'''

DEFAULT_CFG = {
    "fake_token": FAKE_TOKEN,
    "auth_status_ok": True,
    "public_key_ok": {},
    "secret_set_ok": {},
    "confirm_ok": {},
    "wrangler_whoami_ok": True,
    "wrangler_secret_put_ok": True,
}


def run_case(script_path, extra_args, cfg_overrides=None, wrangler_present=True):
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    if cfg_overrides:
        cfg.update(cfg_overrides)
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        for name, text in (("gh", GH_STUB_PY), ("openssl", OPENSSL_STUB_PY)):
            p = binp / name
            p.write_text(text, encoding="utf-8")
            p.chmod(0o755)

        # SCRIPT_DIR is derived from ${BASH_SOURCE[0]}, so the script is copied into
        # a sandboxed <tmp>/scripts/ with a sibling <tmp>/worker/, exactly like the
        # real repo layout -- rather than running in place against the real
        # worker/node_modules, which this test no longer depends on at all.
        scripts_dir = tdp / "scripts"
        scripts_dir.mkdir()
        sandboxed_script = scripts_dir / "rotate-telemetry-token.sh"
        sandboxed_script.write_text(script_path.read_text(encoding="utf-8"), encoding="utf-8")
        sandboxed_script.chmod(0o755)

        wrangler_bin_dir = tdp / "worker" / "node_modules" / ".bin"
        wrangler_bin_dir.mkdir(parents=True)
        if wrangler_present:
            wrangler_bin = wrangler_bin_dir / "wrangler"
            wrangler_bin.write_text(WRANGLER_STUB_PY, encoding="utf-8")
            wrangler_bin.chmod(0o755)

        cfg_file = tdp / "cfg.json"
        cfg_file.write_text(json.dumps(cfg), encoding="utf-8")

        logs = {name: tdp / f"{name}.log" for name in (
            "gh_argv", "gh_stdin", "openssl_argv", "wrangler_argv", "wrangler_stdin", "seq",
        )}
        for p in logs.values():
            p.write_text("", encoding="utf-8")

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            MOCK_CONFIG_FILE=str(cfg_file),
            GH_ARGV_LOG=str(logs["gh_argv"]),
            GH_STDIN_LOG=str(logs["gh_stdin"]),
            OPENSSL_ARGV_LOG=str(logs["openssl_argv"]),
            WRANGLER_ARGV_LOG=str(logs["wrangler_argv"]),
            WRANGLER_STDIN_LOG=str(logs["wrangler_stdin"]),
            SEQ_LOG=str(logs["seq"]),
        )

        proc = subprocess.run(
            ["bash", str(sandboxed_script), *extra_args],
            cwd=str(tdp),
            env=env,
            capture_output=True,
            text=True,
        )
        result = {name: p.read_text(encoding="utf-8") for name, p in logs.items()}
        result["proc"] = proc
        return result


def test_suite():
    print("=== Testing rotate-telemetry-token.sh ===")

    # Case 1: the token lands on stdin everywhere it is set, and nowhere else.
    r = run_case(SCRIPT, [])
    proc = r["proc"]
    assert proc.returncode == 0, f"Case 1 failed (exit {proc.returncode}):\n{proc.stderr}\n{proc.stdout}"
    assert FAKE_TOKEN in r["gh_stdin"], "token did not reach gh secret set via stdin"
    assert FAKE_TOKEN in r["wrangler_stdin"], "token did not reach wrangler secret put via stdin"
    for name in ("gh_argv", "openssl_argv", "wrangler_argv"):
        assert FAKE_TOKEN not in r[name], f"token leaked into {name}"
    assert FAKE_TOKEN not in proc.stdout, "token leaked into stdout"
    assert FAKE_TOKEN not in proc.stderr, "token leaked into stderr"
    print("  ok    token travels only on stdin, never in an argv, stdout or stderr")

    # Case 2: order is every repo, then the Worker.
    seq = [line for line in r["seq"].splitlines() if line]
    expected = [f"gh-secret-set {repo}" for repo in DEFAULT_REPOS] + ["wrangler-secret-put worker"]
    assert seq == expected, f"unexpected order: {seq}"
    print("  ok    order is every repo, then the Worker")

    # Case 3: a failing third repo stops before the Worker; output names 1-2 as
    # rotated and 3-4 as not.
    r = run_case(SCRIPT, [], cfg_overrides={"secret_set_ok": {"prismalens/gh-workflows": False}})
    proc = r["proc"]
    assert proc.returncode != 0, "Case 3 expected non-zero exit"
    seq = [line for line in r["seq"].splitlines() if line]
    assert seq == [
        "gh-secret-set prismalens/prismalens",
        "gh-secret-set prismalens/sreforge",
        "gh-secret-set prismalens/gh-workflows",  # attempted, stub returns failure
    ], seq
    assert "wrangler-secret-put worker" not in r["seq"], "Worker was touched after a repo failure"
    rotated_line = next(l for l in proc.stdout.splitlines() if "rotated:" in l and "not rotated" not in l)
    not_rotated_line = next(l for l in proc.stdout.splitlines() if "not rotated:" in l)
    assert "prismalens/prismalens" in rotated_line and "prismalens/sreforge" in rotated_line, rotated_line
    assert "prismalens/gh-workflows" in not_rotated_line and "Sumit1993/mage-memory" in not_rotated_line, not_rotated_line
    print("  ok    failing third repo stops before the Worker, names repos 1-2 vs 3-4")

    # Case 3b: a set that cannot be confirmed (updated_at missing) stops the run
    # exactly like a failed `secret set`, and never reaches the Worker.
    r = run_case(SCRIPT, [], cfg_overrides={"confirm_ok": {"prismalens/sreforge": False}})
    proc = r["proc"]
    assert proc.returncode != 0, "Case 3b expected non-zero exit on an unconfirmed set"
    seq = [line for line in r["seq"].splitlines() if line]
    assert seq == [
        "gh-secret-set prismalens/prismalens",
        "gh-secret-set prismalens/sreforge",
    ], seq
    assert "wrangler-secret-put worker" not in r["seq"], "Worker was touched after an unconfirmed set"
    print("  ok    an unconfirmed set stops the run before the Worker")

    # Case 4: a preflight failure makes zero secret set calls.
    r = run_case(SCRIPT, [], cfg_overrides={"public_key_ok": {"prismalens/sreforge": False}})
    proc = r["proc"]
    assert proc.returncode != 0, "Case 4 expected non-zero exit"
    assert r["seq"].strip() == "", f"preflight failure still wrote: {r['seq']}"
    assert "FAIL  prismalens/sreforge" in proc.stdout, proc.stdout
    print("  ok    preflight failure makes zero secret set calls")

    # Case 5: --dry-run makes zero writes.
    r = run_case(SCRIPT, ["--dry-run"])
    proc = r["proc"]
    assert proc.returncode == 0, f"Case 5 failed:\n{proc.stderr}\n{proc.stdout}"
    assert r["seq"].strip() == "", f"--dry-run still wrote: {r['seq']}"
    assert "DRY RUN" in proc.stdout, proc.stdout
    print("  ok    --dry-run makes zero writes")

    # Case 6: the default list contains the personal-account repo missed on 2026-09-01.
    src = SCRIPT.read_text(encoding="utf-8")
    m = re.search(r"^REPOS=\((.*)\)", src, re.MULTILINE)
    assert m, "could not find the default REPOS array in the script"
    assert "Sumit1993/mage-memory" in m.group(1), "default list is missing Sumit1993/mage-memory"
    print("  ok    default list contains Sumit1993/mage-memory")

    # Case 7: preflight fails, naming npm ci, when worker/node_modules/.bin/wrangler
    # is absent -- never falling back to an unpinned npx download (CR #173, thread
    # 4000816186).
    r = run_case(SCRIPT, [], wrangler_present=False)
    proc = r["proc"]
    assert proc.returncode != 0, "Case 7 expected non-zero exit when wrangler is absent"
    assert r["seq"].strip() == "", f"preflight failure still wrote: {r['seq']}"
    assert "run npm ci in worker/ first" in proc.stdout, proc.stdout
    assert r["wrangler_argv"] == "", "wrangler must never be invoked when it is absent"
    print("  ok    preflight fails naming 'npm ci in worker/' when wrangler is absent")

    print("\nAll 8 test cases passed successfully.")


if __name__ == "__main__":
    test_suite()
