"""Shared helper: run an extracted step script under bash with a fake PATH.

Not a `test-*.py` file, so tests.yml's coverage check never expects a step for it.
"""
import os
import pathlib
import subprocess


def write_fake(bin_dir: pathlib.Path, name: str, body: str) -> None:
    p = bin_dir / name
    p.write_text("#!/usr/bin/env bash\n" + body, newline="\n")
    p.chmod(0o755)


def run_step(script: str, env: dict, bin_dir: pathlib.Path | None = None, cwd=None, timeout=60):
    full = {**os.environ, **env}
    if bin_dir is not None:
        full["PATH"] = f"{bin_dir}{os.pathsep}{full['PATH']}"
    return subprocess.run(["bash", "-e", "-c", script], env=full, cwd=cwd,
                          capture_output=True, text=True, timeout=timeout)
