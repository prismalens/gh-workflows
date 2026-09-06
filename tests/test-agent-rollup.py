#!/usr/bin/env python3
"""Behavioural tests for the Roll up subagent transcripts step.

Extracts the REAL shell body out of claude-code-review.yml and runs it against
fixtures, verifying:
1. Two agents with transcripts: correct join, correct sums, correct sorted order.
2. A task_started with no transcript: identity present, token counts null.
3. A transcript with no task_started: cost present, identity null.
4. A malformed transcript line: skipped, the rest still counted, a warning emitted.
5. A missing transcript directory: emits [], warns, exit 0.
6. 65 agents: truncated to 64 with a warning.
7. file_paths is distinct and sorted, and contains only file_path values.
8. tool_uses_by_name counts correctly across multiple tool types.
9. Model changes mid-transcript: reports last model and warns.
10. Telemetry step integration: AGENTS is included in the telemetry record under 'agents'.
11. Absent session_id: emits [], warns, exit 0.
12. Missing execution file: emits [], warns, exit 0.
13. Skipped review outcome: emits [], no warning, exit 0.

Run: python3 tests/test-agent-rollup.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/claude-code-review.yml"
ROLLUP_STEP = "Roll up subagent transcripts"
TELEMETRY_STEP = "Extract review round telemetry"


def extract_step_script(step_name: str) -> str:
    wf = yaml.safe_load(WF.read_text())
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == step_name:
                return step["run"]
    sys.exit(f"step {step_name!r} not found in {WF}")


def run_rollup_step(script, *,
                    execution_events=None,
                    execution_file_path=None,
                    execution_file_raw=None,
                    session_id="session-xyz-123",
                    transcript_files=None,
                    env_overrides=None,
                    create_transcript_dir=True):
    """Runs the extracted rollup step in a sandbox environment."""
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        home_dir = tdp / "home"
        home_dir.mkdir()
        gh_output = tdp / "github_output.txt"
        gh_output.touch()

        # Transcript dir setup
        if create_transcript_dir and session_id:
            subagents_dir = home_dir / ".claude" / "projects" / "test-slug" / session_id / "subagents"
            subagents_dir.mkdir(parents=True, exist_ok=True)
            if transcript_files:
                for fname, content in transcript_files.items():
                    (subagents_dir / fname).write_text(content)

        # Execution file setup
        if execution_file_path is not None:
            ef_path = execution_file_path
        elif execution_file_raw is not None:
            ef = tdp / "execution.json"
            ef.write_text(execution_file_raw)
            ef_path = str(ef)
        elif execution_events is not None:
            ef = tdp / "execution.json"
            ef.write_text(json.dumps(execution_events))
            ef_path = str(ef)
        else:
            ef_path = ""

        env = dict(os.environ)
        env.update(
            HOME=str(home_dir),
            SESSION_ID=session_id if session_id is not None else "",
            EXECUTION_FILE=ef_path,
            CLAUDE_OUTCOME="success",
            GITHUB_OUTPUT=str(gh_output),
        )
        if env_overrides:
            env.update(env_overrides)

        proc = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)

        agents = None
        status = None
        if gh_output.exists():
            for line in gh_output.read_text().splitlines():
                if line.startswith("agents="):
                    try:
                        agents = json.loads(line[len("agents="):])
                    except Exception as e:
                        agents = f"MALFORMED_JSON: {e}"
                elif line.startswith("agents_status="):
                    status = line[len("agents_status="):]

        return proc.returncode, agents, proc.stdout + proc.stderr + f"\n__AGENTS_STATUS__={status}"


def run_telemetry_step(script, *, execution_file_content, agents_json_str):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        ef = tdp / "execution.json"
        ef.write_text(execution_file_content)
        gh_output = tdp / "github_output.txt"
        gh_output.touch()

        env = dict(os.environ)
        env.update(
            EXECUTION_FILE=str(ef),
            AGENTS=agents_json_str,
            REPO="prismalens/test-repo",
            PR_NUMBER="42",
            SERVER_URL="https://github.com",
            RUN_ID="12345",
            RUN_ATTEMPT="1",
            ROUND_TYPE="review",
            MODEL="claude-sonnet-5",
            RESOLVE_CHANGED_FILES="1",
            RESOLVE_DIFF_LINES="10",
            CLAUDE_OUTCOME="success",
            HEAD_SHA="a" * 40,
            PROMPT_HASH="hash1",
            ACTION_VERSION="v1",
            CONFIG_HASH="hash2",
            VARIANT="control",
            GITHUB_OUTPUT=str(gh_output),
        )

        proc = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)

        record = None
        if gh_output.exists():
            content = gh_output.read_text()
            lines = content.splitlines()
            i = 0
            while i < len(lines):
                line = lines[i]
                if line.startswith("record<<"):
                    delim = line[len("record<<"):]
                    rec_lines = []
                    i += 1
                    while i < len(lines) and lines[i] != delim:
                        rec_lines.append(lines[i])
                        i += 1
                    record = json.loads("\n".join(rec_lines))
                i += 1

        return proc.returncode, record, proc.stdout + proc.stderr


def main():
    script = extract_step_script(ROLLUP_STEP)
    telemetry_script = extract_step_script(TELEMETRY_STEP)
    fails = []

    print(f"=== Testing {ROLLUP_STEP} against real workflow body ===\n")

    # -------------------------------------------------------------
    # 1. Two agents with transcripts: correct join, sums, sorted order
    # -------------------------------------------------------------
    exec_events_1 = [
        {"type": "system", "subtype": "task_started", "task_id": "agent-02", "subagent_type": "reviewer", "spawn_depth": 2},
        {"type": "system", "subtype": "task_started", "task_id": "agent-01", "subagent_type": "worker", "spawn_depth": 1},
        {"type": "system", "subtype": "task_notification", "task_id": "agent-02", "status": "completed", "usage": {"duration_ms": 3000, "tool_uses": 2}},
        {"type": "system", "subtype": "task_notification", "task_id": "agent-01", "status": "completed", "usage": {"duration_ms": 5000, "tool_uses": 4}},
    ]
    agent_01_lines = "\n".join([
        json.dumps({"type": "assistant", "message": {"model": "claude-opus-5", "role": "assistant", "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 5, "cache_creation_input_tokens": 15}, "content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "src/app.py"}}]}}),
        json.dumps({"type": "assistant", "message": {"model": "claude-opus-5", "role": "assistant", "usage": {"input_tokens": 200, "output_tokens": 30, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 25}, "content": [{"type": "tool_use", "name": "Grep", "input": {"pattern": "def foo"}}]}}),
    ])
    agent_02_lines = "\n".join([
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "role": "assistant", "usage": {"input_tokens": 50, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 5}, "content": [{"type": "tool_use", "name": "Glob", "input": {"pattern": "*.py"}}]}}),
    ])
    transcripts_1 = {
        "agent-agent-02.jsonl": agent_02_lines,
        "agent-agent-01.jsonl": agent_01_lines,
    }
    rc, agents, output = run_rollup_step(script, execution_events=exec_events_1, transcript_files=transcripts_1)
    if rc != 0:
        fails.append(f"case 1: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 2:
        fails.append(f"case 1: expected 2 agents, got {agents}")
    else:
        if agents[0]["agent_id"] != "agent-01" or agents[1]["agent_id"] != "agent-02":
            fails.append(f"case 1: agents not sorted by agent_id: {[a['agent_id'] for a in agents]}")
        a1 = agents[0]
        if a1["subagent_type"] != "worker" or a1["spawn_depth"] != 1 or a1["status"] != "completed":
            fails.append(f"case 1: agent-01 identity mismatch: {a1}")
        if a1["duration_ms"] != 5000 or a1["tool_uses"] != 4:
            fails.append(f"case 1: agent-01 notification usage mismatch: {a1}")
        if a1["model"] != "claude-opus-5":
            fails.append(f"case 1: agent-01 model mismatch: {a1['model']}")
        if a1["input_tokens"] != 300 or a1["output_tokens"] != 50 or a1["cache_read_input_tokens"] != 15 or a1["cache_creation_input_tokens"] != 40:
            fails.append(f"case 1: agent-01 token sum mismatch: {a1}")
        if json.loads(a1["tool_uses_by_name"]) != {"Grep": 1, "Read": 1}:
            fails.append(f"case 1: agent-01 tool_uses_by_name mismatch: {a1['tool_uses_by_name']}")
        if json.loads(a1["file_paths"]) != ["src/app.py"]:
            fails.append(f"case 1: agent-01 file_paths mismatch: {a1['file_paths']}")

        a2 = agents[1]
        if a2["subagent_type"] != "reviewer" or a2["spawn_depth"] != 2 or a2["status"] != "completed":
            fails.append(f"case 1: agent-02 identity mismatch: {a2}")
        if a2["input_tokens"] != 50 or a2["output_tokens"] != 10 or a2["cache_read_input_tokens"] != 0 or a2["cache_creation_input_tokens"] != 5:
            fails.append(f"case 1: agent-02 token sum mismatch: {a2}")
        if json.loads(a2["tool_uses_by_name"]) != {"Glob": 1}:
            fails.append(f"case 1: agent-02 tool_uses_by_name mismatch: {a2['tool_uses_by_name']}")
        if json.loads(a2["file_paths"]) != []:
            fails.append(f"case 1: agent-02 file_paths mismatch: {a2['file_paths']}")
        print("  ok    two agents with transcripts: correct join, sums, and sorted order")

    # -------------------------------------------------------------
    # 2. task_started with no transcript: identity present, token counts null
    # -------------------------------------------------------------
    exec_events_2 = [
        {"type": "system", "subtype": "task_started", "task_id": "agent-orphan", "subagent_type": "scout", "spawn_depth": 1},
        {"type": "system", "subtype": "task_notification", "task_id": "agent-orphan", "status": "failed", "usage": {"duration_ms": 1200, "tool_uses": 0}},
    ]
    rc, agents, output = run_rollup_step(script, execution_events=exec_events_2, transcript_files={})
    if rc != 0:
        fails.append(f"case 2: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 1:
        fails.append(f"case 2: expected 1 agent, got {agents}")
    else:
        a = agents[0]
        if a["agent_id"] != "agent-orphan" or a["subagent_type"] != "scout" or a["spawn_depth"] != 1 or a["status"] != "failed" or a["duration_ms"] != 1200 or a["tool_uses"] != 0:
            fails.append(f"case 2: identity/notification mismatch: {a}")
        if a["model"] is not None:
            fails.append(f"case 2: model should be null, got {a['model']}")
        if a["input_tokens"] is not None or a["output_tokens"] is not None or a["cache_read_input_tokens"] is not None or a["cache_creation_input_tokens"] is not None:
            fails.append(f"case 2: token counts should be null, got {a}")
        if a["tool_uses_by_name"] != "{}" or a["file_paths"] != "[]":
            fails.append(f"case 2: tool_uses_by_name/file_paths should be empty JSON, got {a}")
        print("  ok    task_started with no transcript: identity present, token counts null")

    # -------------------------------------------------------------
    # 3. Transcript with no task_started: cost present, identity null
    # -------------------------------------------------------------
    ghost_lines = json.dumps({
        "type": "assistant",
        "message": {
            "model": "claude-haiku-4",
            "role": "assistant",
            "usage": {"input_tokens": 123, "output_tokens": 45, "cache_read_input_tokens": 6, "cache_creation_input_tokens": 7},
            "content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "README.md"}}],
        },
    })
    rc, agents, output = run_rollup_step(script, execution_events=[], transcript_files={"agent-ghost.jsonl": ghost_lines})
    if rc != 0:
        fails.append(f"case 3: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 1:
        fails.append(f"case 3: expected 1 agent, got {agents}")
    else:
        a = agents[0]
        if a["agent_id"] != "ghost":
            fails.append(f"case 3: agent_id mismatch: {a['agent_id']}")
        if a["subagent_type"] is not None or a["spawn_depth"] is not None or a["status"] is not None or a["duration_ms"] is not None or a["tool_uses"] is not None:
            fails.append(f"case 3: identity fields should be null, got {a}")
        if a["model"] != "claude-haiku-4":
            fails.append(f"case 3: model mismatch: {a['model']}")
        if a["input_tokens"] != 123 or a["output_tokens"] != 45 or a["cache_read_input_tokens"] != 6 or a["cache_creation_input_tokens"] != 7:
            fails.append(f"case 3: token counts mismatch: {a}")
        if json.loads(a["tool_uses_by_name"]) != {"Read": 1}:
            fails.append(f"case 3: tool_uses_by_name mismatch: {a['tool_uses_by_name']}")
        if json.loads(a["file_paths"]) != ["README.md"]:
            fails.append(f"case 3: file_paths mismatch: {a['file_paths']}")
        print("  ok    transcript with no task_started: cost present, identity null")

    # -------------------------------------------------------------
    # 4. Malformed transcript line: skipped, rest counted, warning emitted
    # -------------------------------------------------------------
    corrupt_lines = "\n".join([
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 100, "output_tokens": 10}}}),
        "NOT_VALID_JSON {{{",
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 200, "output_tokens": 20}}}),
    ])
    rc, agents, output = run_rollup_step(script, execution_events=[], transcript_files={"agent-corrupt.jsonl": corrupt_lines})
    if rc != 0:
        fails.append(f"case 4: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 1:
        fails.append(f"case 4: expected 1 agent, got {agents}")
    else:
        a = agents[0]
        if a["input_tokens"] != 300 or a["output_tokens"] != 30:
            fails.append(f"case 4: sums should be 300 and 30, got {a['input_tokens']} and {a['output_tokens']}")
        if "::warning::" not in output:
            fails.append("case 4: expected ::warning:: for malformed line")
        print("  ok    malformed transcript line: skipped, rest counted, warning emitted")

    # -------------------------------------------------------------
    # 5. Missing transcript directory: emits [], warns, exit 0
    # -------------------------------------------------------------
    rc, agents, output = run_rollup_step(script, execution_events=exec_events_1, create_transcript_dir=False)
    if rc != 0:
        fails.append(f"case 5: missing transcript dir exited {rc}: {output}")
    elif agents != []:
        fails.append(f"case 5: expected [], got {agents}")
    elif "::warning::" not in output:
        fails.append("case 5: expected ::warning:: for missing transcript dir")
    else:
        print("  ok    missing transcript directory: emits [], warns, exit 0")

    # -------------------------------------------------------------
    # 6. 65 agents: truncated to 64 with a warning
    # -------------------------------------------------------------
    many_events = []
    for i in range(65):
        tid = f"agent-{i:03d}"
        many_events.append({"type": "system", "subtype": "task_started", "task_id": tid, "subagent_type": "tester", "spawn_depth": 1})
    rc, agents, output = run_rollup_step(script, execution_events=many_events, transcript_files={})
    if rc != 0:
        fails.append(f"case 6: 65 agents exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 64:
        fails.append(f"case 6: expected 64 agents, got {len(agents) if isinstance(agents, list) else agents}")
    elif "::warning::" not in output or "64" not in output:
        fails.append(f"case 6: expected truncation warning mentioning 64 in {output}")
    else:
        print("  ok    65 agents: truncated to 64 with a warning")

    # -------------------------------------------------------------
    # 7. file_paths is distinct, sorted, and contains only file_path values
    # -------------------------------------------------------------
    fp_lines = "\n".join([
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "z_dir/last.py"}},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "a_dir/first.py"}},
            {"type": "tool_use", "name": "Write", "input": {"file_path": "z_dir/last.py"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "echo test", "path": "ignore/not_file_path.py"}},
            {"type": "tool_use", "name": "Glob", "input": {"pattern": "**/*.py"}},
        ]}}),
    ])
    rc, agents, output = run_rollup_step(script, execution_events=[], transcript_files={"agent-fps.jsonl": fp_lines})
    if rc != 0:
        fails.append(f"case 7: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 1:
        fails.append(f"case 7: expected 1 agent, got {agents}")
    else:
        fps = json.loads(agents[0]["file_paths"])
        if fps != ["a_dir/first.py", "z_dir/last.py"]:
            fails.append(f"case 7: expected ['a_dir/first.py', 'z_dir/last.py'], got {fps}")
        print("  ok    file_paths: distinct, sorted, only file_path values")

    # -------------------------------------------------------------
    # 8. tool_uses_by_name counts correctly across multiple tool types
    # -------------------------------------------------------------
    tools_lines = "\n".join([
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": "a.py"}},
            {"type": "tool_use", "name": "Read", "input": {"file_path": "b.py"}},
            {"type": "tool_use", "name": "Grep", "input": {"pattern": "x"}},
        ]}}),
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "content": [
            {"type": "tool_use", "name": "Grep", "input": {"pattern": "y"}},
            {"type": "tool_use", "name": "Grep", "input": {"pattern": "z"}},
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
        ]}}),
    ])
    rc, agents, output = run_rollup_step(script, execution_events=[], transcript_files={"agent-tools.jsonl": tools_lines})
    if rc != 0:
        fails.append(f"case 8: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 1:
        fails.append(f"case 8: expected 1 agent, got {agents}")
    else:
        tmap = json.loads(agents[0]["tool_uses_by_name"])
        if tmap != {"Bash": 1, "Grep": 3, "Read": 2}:
            fails.append(f"case 8: expected {{'Bash': 1, 'Grep': 3, 'Read': 2}}, got {tmap}")
        print("  ok    tool_uses_by_name: counts correctly across multiple tool types")

    # -------------------------------------------------------------
    # 9. Model changed mid-transcript: reports last model and warns
    # -------------------------------------------------------------
    model_change_lines = "\n".join([
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "usage": {"input_tokens": 10}}}),
        json.dumps({"type": "assistant", "message": {"model": "claude-opus-5", "usage": {"input_tokens": 20}}}),
    ])
    rc, agents, output = run_rollup_step(script, execution_events=[], transcript_files={"agent-model-change.jsonl": model_change_lines})
    if rc != 0:
        fails.append(f"case 9: exited {rc}: {output}")
    elif not isinstance(agents, list) or len(agents) != 1:
        fails.append(f"case 9: expected 1 agent, got {agents}")
    else:
        a = agents[0]
        if a["model"] != "claude-opus-5":
            fails.append(f"case 9: expected last model claude-opus-5, got {a['model']}")
        if "::warning::" not in output or "changed model" not in output:
            fails.append(f"case 9: expected model change warning, got {output}")
        print("  ok    model change mid-transcript: reports last model and warns")

    # -------------------------------------------------------------
    # 10. Absent session_id: emits [], warns, exit 0
    # -------------------------------------------------------------
    rc, agents, output = run_rollup_step(script, execution_events=exec_events_1, session_id="")
    if rc != 0:
        fails.append(f"case 10: absent session_id exited {rc}: {output}")
    elif agents != []:
        fails.append(f"case 10: expected [], got {agents}")
    elif "::warning::" not in output:
        fails.append(f"case 10: expected warning for absent session_id, got {output}")
    else:
        print("  ok    absent session_id: emits [], warns, exit 0")

    # -------------------------------------------------------------
    # 11. Missing execution file: emits [], warns, exit 0
    # -------------------------------------------------------------
    rc, agents, output = run_rollup_step(script, execution_file_path="/nonexistent/execution.json")
    if rc != 0:
        fails.append(f"case 11: missing execution file exited {rc}: {output}")
    elif agents != []:
        fails.append(f"case 11: expected [], got {agents}")
    elif "::warning::" not in output:
        fails.append(f"case 11: expected warning for missing execution file, got {output}")
    else:
        print("  ok    missing execution file: emits [], warns, exit 0")

    # -------------------------------------------------------------
    # 12. Skipped review: emits [], no warning, exit 0
    # -------------------------------------------------------------
    rc, agents, output = run_rollup_step(script, execution_file_path="/nonexistent/execution.json", env_overrides={"CLAUDE_OUTCOME": "skipped"})
    if rc != 0:
        fails.append(f"case 12: skipped review exited {rc}: {output}")
    elif agents != []:
        fails.append(f"case 12: expected [], got {agents}")
    elif "::warning::" in output:
        fails.append(f"case 12: skipped review should not emit warning, got {output}")
    else:
        print("  ok    skipped review: emits [], no warning, exit 0")

    # -------------------------------------------------------------
    # 13. Telemetry step integration: record has top-level 'agents'
    # -------------------------------------------------------------
    exec_content = json.dumps([
        {"type": "result", "session_id": "sess-integ", "total_cost_usd": 0.05, "duration_ms": 10000, "num_turns": 5, "permission_denials": 0, "modelUsage": {"claude-sonnet-5": {"inputTokens": 100, "outputTokens": 20}}}
    ])
    mock_agents = [{"agent_id": "agent-01", "status": "completed", "input_tokens": 100}]
    rc, record, out = run_telemetry_step(telemetry_script, execution_file_content=exec_content, agents_json_str=json.dumps(mock_agents))
    if rc != 0:
        fails.append(f"case 13: telemetry step exited {rc}: {out}")
    elif not isinstance(record, dict):
        fails.append(f"case 13: telemetry record not a dict: {record}")
    elif "agents" not in record:
        fails.append(f"case 13: 'agents' key missing in telemetry record: {record}")
    elif record["agents"] != mock_agents:
        fails.append(f"case 13: agents in record mismatch: {record.get('agents')}")
    else:
        print("  ok    telemetry step integration: includes agents in record under top-level key")

    # -------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------
    # -----------------------------------------------------------------
    # 14. agents_status distinguishes a failed rollup from a round with no agents.
    #     `agents: []` alone cannot, and #89 needs the distinction. Story: #93.
    # -----------------------------------------------------------------
    _, _, out_missing = run_rollup_step(
        script,
        execution_events=exec_events_1,
        transcript_files={},
        create_transcript_dir=False,
    )
    _, _, out_skipped = run_rollup_step(
        script,
        execution_events=exec_events_1,
        transcript_files=transcripts_1,
        env_overrides={"CLAUDE_OUTCOME": "skipped"},
    )
    _, agents_ok, out_ok = run_rollup_step(
        script,
        execution_events=exec_events_1,
        transcript_files=transcripts_1,
    )

    expectations = [
        ("no-transcript-dir", out_missing, "missing transcript directory"),
        ("skipped", out_skipped, "skipped review"),
        ("ok", out_ok, "successful rollup"),
    ]
    status_fails = []
    for expected, out, label in expectations:
        if f"__AGENTS_STATUS__={expected}" not in out:
            status_fails.append(f"case 14: {label} expected agents_status={expected}, got: {out.splitlines()[-1] if out else '(no output)'}")

    if status_fails:
        fails.extend(status_fails)
        print("  FAIL  agents_status: a failed rollup is indistinguishable from an empty one")
    elif agents_ok is None or len(agents_ok) == 0:
        fails.append("case 14: the ok case produced no agents, so the status assertion proves nothing")
        print("  FAIL  agents_status: ok case had no agents")
    else:
        print("  ok    agents_status: names why the array is empty, and reads ok when it is not")

    print(f"\n{len(fails)} failure(s)")
    if fails:
        for f in fails:
            print(f"  FAIL: {f}")
        sys.exit(1)
    else:
        print("All agent rollup tests passed successfully.")


if __name__ == "__main__":
    main()
