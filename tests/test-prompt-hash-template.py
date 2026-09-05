#!/usr/bin/env python3
"""Proves prompt_hash is computed over the prompt TEMPLATE, never the substituted text (#47
amendment).

Extracts the REAL "Build the review prompt" step's shell body out of
.github/workflows/claude-code-review.yml and runs it for real, twice, with different
per-run substitution values (repo, PR number, round-mode text). A hash over the
substituted text would differ between those two runs. A hash over the template — written
to disk with @@TOKEN@@ placeholders still in place, before substitution — does not: it
only changes when the checked-in prompt content itself changes.

Run: python3 tests/test-prompt-hash-template.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
STEP_ID = "build-prompt"

# Two runs of the SAME workflow version, standing in for two different PRs / round types.
RUN_A_ENV = {
    "REPO": "acme/widgets",
    "PR_NUMBER": "42",
    "STEP3_TASK": "Launch a sonnet agent to view the pull request and return a summary of the changes",
    "AGENT3_FOCUS": "Focus only on the diff itself without reading extra context.",
    "AGENT4_FOCUS": "Only look for issues that fall within the changed code.",
    "STEP4_CONTEXT_SUFFIX": "",
    "STEP9_HEADER": "## Code review",
    "DEDUP_DISABLED_BLOCK": "",
    "INCREMENTAL_ROUND_BLOCK": "",
}
RUN_B_ENV = {
    "REPO": "someorg/other-repo",
    "PR_NUMBER": "9001",
    "STEP3_TASK": (
        "Launch a sonnet agent to return a summary of the changes covering the range "
        "aaa111..bbb222, whose changed files and patches are in `.claude-incremental-range.json` "
        "in the repository root. The agent should read that file rather than treat the whole PR "
        "diff as its subject"
    ),
    "AGENT3_FOCUS": (
        "Focus on the range, with the rest of the PR diff available as context for understanding "
        "it but not as a source of findings."
    ),
    "AGENT4_FOCUS": "Only look for issues that fall within the range.",
    "STEP4_CONTEXT_SUFFIX": ", the commit range aaa111..bbb222, and the path `.claude-incremental-range.json`",
    "STEP9_HEADER": "## Code review — incremental (aaa111..bbb222)",
    "DEDUP_DISABLED_BLOCK": "",
    "INCREMENTAL_ROUND_BLOCK": (
        "THIS IS AN INCREMENTAL ROUND covering commits aaa111..bbb222 only. Read it first."
    ),
}


def load_build_prompt_script():
    data = yaml.safe_load(WF.read_text(encoding="utf-8"))
    steps = data["jobs"]["review"]["steps"]
    step = next(s for s in steps if s.get("id") == STEP_ID)
    return step["run"]


def run_step(script, env_overrides, runner_temp):
    env = dict(os.environ)
    env.update(env_overrides)
    env["RUNNER_TEMP"] = str(runner_temp)
    output_path = runner_temp / "github_output.txt"
    output_path.write_text("", encoding="utf-8")
    env["GITHUB_OUTPUT"] = str(output_path)

    proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env)
    return proc, output_path.read_text(encoding="utf-8")


def parse_outputs(output_text):
    """Parse GITHUB_OUTPUT-format text, including `key<<DELIM ... DELIM` multi-line values."""
    result = {}
    lines = output_text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if "<<" in line and "=" not in line.split("<<")[0]:
            key, delim = line.split("<<", 1)
            i += 1
            body_lines = []
            while i < len(lines) and lines[i] != delim:
                body_lines.append(lines[i])
                i += 1
            result[key] = "\n".join(body_lines)
            i += 1
        elif "=" in line:
            key, _, value = line.partition("=")
            result[key] = value
            i += 1
        else:
            i += 1
    return result


def main():
    fails = []
    script = load_build_prompt_script()

    with tempfile.TemporaryDirectory() as tmp_a, tempfile.TemporaryDirectory() as tmp_b:
        proc_a, out_a = run_step(script, RUN_A_ENV, pathlib.Path(tmp_a))
        proc_b, out_b = run_step(script, RUN_B_ENV, pathlib.Path(tmp_b))

        if proc_a.returncode != 0:
            fails.append(f"run A failed: {proc_a.stderr}")
            print(f"  FAIL  run A exited {proc_a.returncode}: {proc_a.stderr}")
        if proc_b.returncode != 0:
            fails.append(f"run B failed: {proc_b.stderr}")
            print(f"  FAIL  run B exited {proc_b.returncode}: {proc_b.stderr}")

        if not fails:
            outputs_a = parse_outputs(out_a)
            outputs_b = parse_outputs(out_b)

            hash_a = outputs_a.get("prompt_hash")
            hash_b = outputs_b.get("prompt_hash")
            prompt_a = outputs_a.get("prompt")
            prompt_b = outputs_b.get("prompt")

            if not hash_a or not hash_b:
                fails.append(f"missing prompt_hash output: a={hash_a!r} b={hash_b!r}")
                print("  FAIL  prompt_hash output missing")
            elif hash_a != hash_b:
                fails.append(
                    f"prompt_hash differed between two runs with different substituted values "
                    f"({hash_a} vs {hash_b}); it should hash the template, not the rendered text"
                )
                print(f"  FAIL  prompt_hash changed with substituted text: {hash_a} vs {hash_b}")
            else:
                print(f"  ok    prompt_hash is stable across different repos/PRs/modes: {hash_a}")

            if not prompt_a or not prompt_b:
                fails.append("missing prompt output")
                print("  FAIL  prompt output missing")
            elif prompt_a == prompt_b:
                fails.append("rendered prompt text was identical between two runs with different inputs")
                print("  FAIL  rendered prompt did not vary with substituted values")
            else:
                print("  ok    rendered prompt text differs between the two runs (substitution happened)")

            if "acme/widgets#42" not in (prompt_a or ""):
                fails.append("run A's rendered prompt does not contain its own repo/PR number")
                print("  FAIL  run A prompt missing its own repo/PR substitution")
            else:
                print("  ok    run A's rendered prompt carries its own repo/PR number")

            if "someorg/other-repo#9001" not in (prompt_b or ""):
                fails.append("run B's rendered prompt does not contain its own repo/PR number")
                print("  FAIL  run B prompt missing its own repo/PR substitution")
            else:
                print("  ok    run B's rendered prompt carries its own repo/PR number")

    # A change to the checked-in prompt content (simulating an actual prompt edit) MUST
    # change prompt_hash. Do this by patching the script's heredoc body before executing it.
    if "Provide a code review for the pull request @@REPO@@#@@PR_NUMBER@@." not in script:
        fails.append("could not locate the known first line of the prompt template to mutate")
        print("  FAIL  could not locate template anchor text for the mutation fixture")
    else:
        mutated_script = script.replace(
            "Provide a code review for the pull request @@REPO@@#@@PR_NUMBER@@.",
            "Provide a code review for the pull request @@REPO@@#@@PR_NUMBER@@. EDITED.",
            1,
        )
        with tempfile.TemporaryDirectory() as tmp_c:
            proc_c, out_c = run_step(mutated_script, RUN_A_ENV, pathlib.Path(tmp_c))
            if proc_c.returncode != 0:
                fails.append(f"mutated-template run failed: {proc_c.stderr}")
                print(f"  FAIL  mutated-template run exited {proc_c.returncode}")
            else:
                outputs_c = parse_outputs(out_c)
                hash_c = outputs_c.get("prompt_hash")
                # Re-run the unmodified script once more for a clean baseline comparison.
                with tempfile.TemporaryDirectory() as tmp_d:
                    proc_d, out_d = run_step(script, RUN_A_ENV, pathlib.Path(tmp_d))
                    hash_d = parse_outputs(out_d).get("prompt_hash")
                if hash_c == hash_d:
                    fails.append("prompt_hash did not change after the prompt template content changed")
                    print("  FAIL  prompt_hash insensitive to a real template edit")
                else:
                    print(f"  ok    prompt_hash changes when the template content changes: {hash_d} -> {hash_c}")

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all prompt_hash / template tests passed")


if __name__ == "__main__":
    main()
