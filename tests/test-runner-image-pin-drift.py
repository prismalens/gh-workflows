#!/usr/bin/env python3
"""Guards the runner image's pins against silent drift (#184, spec Q3).

Every FROM is digest-pinned, actionlint matches tests.yml and manifest.py, opencode matches the
admitted engine row, every download is https and checksummed, and every global npm install is pinned.

Run: python3 tests/test-runner-image-pin-drift.py
"""
import pathlib
import re
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "runner/image/Dockerfile"
TESTS_WF = ROOT / ".github/workflows/tests.yml"
MANIFEST_PY = ROOT / "runner/src/manifest.py"
ENGINES_JS = ROOT / "runner/src/engines.js"

ARG_RE = re.compile(r"^ARG\s+([A-Z0-9_]+)=(\S+)\s*$", re.M)
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def check(dockerfile: pathlib.Path, tests_wf: pathlib.Path, manifest_py: pathlib.Path, engines_js: pathlib.Path):
    """Returns a list of failures; empty means the pins agree."""
    fails = []
    text = dockerfile.read_text(encoding="utf-8")
    args = dict(ARG_RE.findall(text))

    for line in re.findall(r"^FROM\s+(\S+)", text, re.M):
        if not re.search(r"@sha256:[0-9a-f]{64}$", line):
            fails.append(f"FROM without a digest: {line}")

    for name, value in args.items():
        if name.endswith("_SHA256") and not HEX64_RE.match(value):
            fails.append(f"ARG {name} is not 64 lowercase hex")

    steps = yaml.safe_load(tests_wf.read_text(encoding="utf-8"))["jobs"]["test"]["steps"]
    lint = next((s for s in steps if s.get("name") == "actionlint"), None)
    if lint is None:
        fails.append("tests.yml: no 'actionlint' step")
    else:
        for key in ("ACTIONLINT_VERSION", "ACTIONLINT_SHA256"):
            if str(lint.get("env", {}).get(key)) != args.get(key):
                fails.append(f"{key}: Dockerfile {args.get(key)} != tests.yml {lint.get('env', {}).get(key)}")

    mtext = manifest_py.read_text(encoding="utf-8")
    for key in ("ACTIONLINT_VERSION", "ACTIONLINT_SHA256"):
        m = re.search(rf'{key} = "([^"]+)"', mtext)
        if not m or m.group(1) != args.get(key):
            fails.append(f"{key}: Dockerfile {args.get(key)} != manifest.py {m.group(1) if m else None}")

    m = re.search(r"admitted: \{ version: '([^']+)'", engines_js.read_text(encoding="utf-8"))
    if not m or m.group(1) != args.get("OPENCODE_VERSION"):
        fails.append(f"OPENCODE_VERSION: Dockerfile {args.get('OPENCODE_VERSION')} != engines.js admitted {m.group(1) if m else None}")

    for line in text.splitlines():
        if re.search(r"\bcurl\s+-", line) and "--proto '=https'" not in line:
            fails.append(f"curl without --proto '=https': {line.strip()}")
    if re.search(r"\|\s*(sh|bash)\b", text):
        fails.append("forbidden in Dockerfile: a pipe into a shell")
    for bad in ("download-actionlint.bash", ":latest"):
        if bad in text:
            fails.append(f"forbidden in Dockerfile: {bad}")
    if text.count("sha256sum -c") < 3:
        fails.append("every download must be checked with sha256sum -c (actionlint, shellcheck, gh)")

    npm = re.search(r"npm install -g[^\n]*((?:\\\n[^\n]*)+)", text)
    if npm:
        for pkg in re.findall(r'"([^"]+)"', npm.group(0)):
            if not re.search(r"@\$\{[A-Z0-9_]+_VERSION\}$", pkg):
                fails.append(f"npm global not pinned to an ARG version: {pkg}")
    return fails


def main():
    fails = check(DOCKERFILE, TESTS_WF, MANIFEST_PY, ENGINES_JS)
    live = DOCKERFILE.read_text(encoding="utf-8")
    negatives = {
        "FROM without digest": re.sub(r"@sha256:[0-9a-f]{64}", "", live, count=1),
        "actionlint version drift": live.replace("ARG ACTIONLINT_VERSION=1.7.12", "ARG ACTIONLINT_VERSION=1.7.11"),
        "opencode version drift": re.sub(r"ARG OPENCODE_VERSION=\S+", "ARG OPENCODE_VERSION=0.0.1", live),
        "unpinned npm global": live.replace('"opencode-ai@${OPENCODE_VERSION}"', '"opencode-ai"'),
        "curl without proto": live.replace("curl --proto '=https' --tlsv1.2 -fsSLo gh.tar.gz", "curl -fsSLo gh.tar.gz"),
        "pipe into a shell": live.replace("&& npm cache clean --force\n\nWORKDIR", "&& curl --proto '=https' -fsSL https://x | sh\n\nWORKDIR", 1),
    }
    with tempfile.TemporaryDirectory() as td:
        for name, content in negatives.items():
            if content == live:
                fails.append(f"negative fixture '{name}' did not change the Dockerfile")
                continue
            p = pathlib.Path(td) / "Dockerfile"
            p.write_text(content, encoding="utf-8")
            if not check(p, TESTS_WF, MANIFEST_PY, ENGINES_JS):
                fails.append(f"negative fixture '{name}' was not caught")
    if fails:
        print("FAIL")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)
    print("runner image pins agree")


if __name__ == "__main__":
    main()
