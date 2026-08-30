#!/usr/bin/env python3
"""Behavioural tests for the Dependabot config drift check workflow.

Extracts the REAL script from .github/workflows/dependabot-config-drift.yml and executes
it against a stubbed `gh` CLI across all drift, matching, missing file, permission skip,
and extra ecosystem scenarios.

Run: python3 tests/test-dependabot-config-drift.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/dependabot-config-drift.yml"
CANONICAL_FILE = ROOT / ".github/dependabot.yml"
STEP_NAME = "Check dependabot config drift"

CANONICAL_CONTENT = CANONICAL_FILE.read_text(encoding="utf-8")

PRISMALENS_CONTENT = """version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    commit-message:
      prefix: chore
      include: scope
    groups:
      dev-minor-patch:
        dependency-type: development
        update-types:
          - minor
          - patch
      prod-minor-patch:
        dependency-type: production
        update-types:
          - minor
          - patch

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: ci
    groups:
      github-actions:
        patterns:
          - "*"
        update-types:
          - minor
          - patch
"""

SREFORGE_CONTENT = """version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: chore
      include: scope
    groups:
      dev-minor-patch:
        dependency-type: development
        update-types:
          - minor
          - patch
      prod-minor-patch:
        dependency-type: production
        update-types:
          - minor
          - patch

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: ci
    groups:
      github-actions:
        patterns:
          - "*"
        update-types:
          - minor
          - patch
"""

MAGE_MEMORY_CONTENT = """version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    open-pull-requests-limit: 5
    commit-message:
      prefix: chore
      include: scope
    groups:
      dev-minor-patch:
        dependency-type: development
        update-types:
          - minor
          - patch
      prod-minor-patch:
        dependency-type: production
        update-types:
          - minor
          - patch

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    commit-message:
      prefix: ci
    groups:
      github-actions:
        patterns:
          - "*"
        update-types:
          - minor
          - patch
"""

DEFAULT_MOCKS = {
    "prismalens/prismalens": {"status": "ok", "yaml_content": PRISMALENS_CONTENT},
    "prismalens/sreforge": {"status": "ok", "yaml_content": SREFORGE_CONTENT},
    "Sumit1993/mage-memory": {"status": "ok", "yaml_content": MAGE_MEMORY_CONTENT},
}

GH_STUB_PY = r"""#!/usr/bin/env python3
import base64
import json
import os
import sys

args = sys.argv[1:]
mock_config_path = os.environ.get("MOCK_CONFIG_FILE", "")
mock_config = {}
if mock_config_path and os.path.exists(mock_config_path):
    with open(mock_config_path, "r", encoding="utf-8") as f:
        mock_config = json.load(f)

# Route 1: Contents fetch (repos/<owner>/<repo>/contents/.github/dependabot.yml)
if len(args) >= 2 and args[0] == "api" and "/contents/.github/dependabot.yml" in args[1]:
    endpoint = args[1]
    repo = endpoint.split("repos/")[1].split("/contents/")[0]
    repo_cfg = mock_config.get(repo, {"status": "ok", "yaml_content": ""})
    status = repo_cfg.get("status", "ok")
    if status == "missing_file":
        print('{"message": "Not Found", "status": "404"}')
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)
    elif status == "permission_denied":
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)
    else:
        content_str = repo_cfg.get("yaml_content", "")
        b64_content = base64.b64encode(content_str.encode("utf-8")).decode("utf-8")
        print(json.dumps({"content": b64_content, "encoding": "base64"}))
        sys.exit(0)

# Route 2: Repo metadata fetch (repos/<owner>/<repo>)
if len(args) >= 2 and args[0] == "api" and args[1].startswith("repos/"):
    repo = args[1].split("repos/")[1].strip("/")
    repo_cfg = mock_config.get(repo, {"status": "ok", "yaml_content": ""})
    status = repo_cfg.get("status", "ok")
    if status == "permission_denied":
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)
    else:
        print(json.dumps({"name": repo.split("/")[-1], "full_name": repo}))
        sys.exit(0)

sys.stderr.write(f"gh stub: unhandled call: {args}\n")
sys.exit(1)
"""


def extract_step_script() -> str:
    wf = yaml.safe_load(WF.read_text(encoding="utf-8"))
    for job in wf["jobs"].values():
        for step in job.get("steps", []) or []:
            if step.get("name") == STEP_NAME:
                run_text = step["run"]
                m = re.search(r"python3(?:\s+-u)?\s+-\s+<<'PY'\n(.*)\nPY", run_text, re.DOTALL)
                if m:
                    return m.group(1)
                return run_text
    sys.exit(f"step {STEP_NAME!r} not found in {WF}")


def run_drift_case(
    script: str,
    *,
    canonical_content: str | None = None,
    mock_repos: dict | None = None,
    remove_canonical: bool = False,
):
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        gh_stub = binp / "gh"
        gh_stub.write_text(GH_STUB_PY, encoding="utf-8")
        gh_stub.chmod(0o755)

        gh_dir = tdp / ".github"
        gh_dir.mkdir()

        if not remove_canonical:
            if canonical_content is not None:
                (gh_dir / "dependabot.yml").write_text(canonical_content, encoding="utf-8")
            else:
                (gh_dir / "dependabot.yml").write_text(CANONICAL_CONTENT, encoding="utf-8")

        mock_config_file = tdp / "mock_config.json"
        repos_to_mock = dict(DEFAULT_MOCKS)
        if mock_repos is not None:
            repos_to_mock.update(mock_repos)
        mock_config_file.write_text(json.dumps(repos_to_mock), encoding="utf-8")

        step_summary_file = tdp / "step_summary.md"

        env = dict(os.environ)
        env.update(
            PATH=f"{binp}:{env['PATH']}",
            MOCK_CONFIG_FILE=str(mock_config_file),
            GITHUB_STEP_SUMMARY=str(step_summary_file),
        )

        proc = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(tdp),
            env=env,
            capture_output=True,
            text=True,
        )

        summary_text = step_summary_file.read_text(encoding="utf-8") if step_summary_file.exists() else ""
        return proc, summary_text


def test_suite():
    script = extract_step_script()
    print("=== Testing Dependabot Config Drift Check Logic ===")

    # Case 1: All four in agreement (Happy path: canonical + 3 consumers match, with extra npm entries ignored)
    proc, summary = run_drift_case(script)
    assert proc.returncode == 0, f"Case 1 failed (exit {proc.returncode}):\n{proc.stderr}\n{proc.stdout}"
    assert "All reachable dependabot configs agree with canonical." in proc.stdout
    assert "✅ All reachable consumer configurations are in sync." in summary
    print("  ok    All four in agreement (passes, exit 0)")

    # Case 2: Differing schedule.interval (fails loudly, names repo and key)
    prismalens_drift = PRISMALENS_CONTENT.replace("interval: weekly", "interval: daily")
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/prismalens": {"status": "ok", "yaml_content": prismalens_drift}},
    )
    assert proc.returncode != 0, "Case 2 expected failure on schedule.interval drift"
    assert "prismalens/prismalens: drift in 'schedule.interval'" in proc.stderr
    assert "canonical: 'weekly', found: 'daily'" in proc.stderr
    print("  ok    Differing schedule.interval (fails, names repo and key)")

    # Case 3: Differing open-pull-requests-limit (fails loudly, names repo and key)
    sreforge_drift = SREFORGE_CONTENT.replace("open-pull-requests-limit: 5", "open-pull-requests-limit: 10")
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/sreforge": {"status": "ok", "yaml_content": sreforge_drift}},
    )
    assert proc.returncode != 0, "Case 3 expected failure on open-pull-requests-limit drift"
    assert "prismalens/sreforge: drift in 'open-pull-requests-limit'" in proc.stderr
    assert "canonical: 5, found: 10" in proc.stderr
    print("  ok    Differing open-pull-requests-limit (fails, names repo and key)")

    # Case 4: Differing commit-message.prefix (fails loudly, names repo and key)
    mage_drift = MAGE_MEMORY_CONTENT.replace("prefix: ci", "prefix: chore")
    proc, summary = run_drift_case(
        script,
        mock_repos={"Sumit1993/mage-memory": {"status": "ok", "yaml_content": mage_drift}},
    )
    assert proc.returncode != 0, "Case 4 expected failure on commit-message.prefix drift"
    assert "Sumit1993/mage-memory: drift in 'commit-message.prefix'" in proc.stderr
    assert "canonical: 'ci', found: 'chore'" in proc.stderr
    print("  ok    Differing commit-message.prefix (fails, names repo and key)")

    # Case 5: Differing group name (fails loudly, names repo)
    prismalens_group_drift = PRISMALENS_CONTENT.replace("github-actions:\n        patterns:", "all-actions:\n        patterns:")
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/prismalens": {"status": "ok", "yaml_content": prismalens_group_drift}},
    )
    assert proc.returncode != 0, "Case 5 expected failure on group name drift"
    assert "prismalens/prismalens: drift in 'groups'" in proc.stderr
    print("  ok    Differing group name (fails, names repo and key)")

    # Case 6: Differing groups patterns (fails loudly, names repo and key)
    sreforge_pattern_drift = SREFORGE_CONTENT.replace("patterns:\n          - \"*\"", "patterns:\n          - \"@actions/*\"")
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/sreforge": {"status": "ok", "yaml_content": sreforge_pattern_drift}},
    )
    assert proc.returncode != 0, "Case 6 expected failure on groups patterns drift"
    assert "prismalens/sreforge: drift in 'groups.github-actions.patterns'" in proc.stderr
    assert "canonical: ['*'], found: ['@actions/*']" in proc.stderr
    print("  ok    Differing groups patterns (fails, names repo and key)")

    # Case 7: Differing groups update-types (fails loudly, names repo and key)
    mage_update_drift = MAGE_MEMORY_CONTENT.replace("update-types:\n          - minor\n          - patch", "update-types:\n          - patch")
    proc, summary = run_drift_case(
        script,
        mock_repos={"Sumit1993/mage-memory": {"status": "ok", "yaml_content": mage_update_drift}},
    )
    assert proc.returncode != 0, "Case 7 expected failure on groups update-types drift"
    assert "Sumit1993/mage-memory: drift in 'groups.github-actions.update-types'" in proc.stderr
    assert "canonical: ['minor', 'patch'], found: ['patch']" in proc.stderr
    print("  ok    Differing groups update-types (fails, names repo and key)")

    # Case 8: Missing .github/dependabot.yml in consumer repo (fails loudly by name)
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/sreforge": {"status": "missing_file"}},
    )
    assert proc.returncode != 0, "Case 8 expected failure on missing dependabot.yml"
    assert "prismalens/sreforge: .github/dependabot.yml not found" in proc.stderr
    assert "prismalens/sreforge" in summary and "❌ Drift / Error" in summary
    print("  ok    Missing dependabot.yml in consumer (fails loudly by name)")

    # Case 9: Missing github-actions ecosystem entry for directory "/" in consumer (fails loudly by name)
    npm_only_content = """version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
"""
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/prismalens": {"status": "ok", "yaml_content": npm_only_content}},
    )
    assert proc.returncode != 0, "Case 9 expected failure on missing github-actions entry"
    assert "prismalens/prismalens: missing github-actions ecosystem entry for directory \"/\"" in proc.stderr
    print("  ok    Missing github-actions root entry in consumer (fails loudly by name)")

    # Case 10: Extra npm ecosystem present (passes, tolerated/ignored)
    # PRISMALENS_CONTENT and others already have npm entries; verifying explicit pass
    proc, summary = run_drift_case(script)
    assert proc.returncode == 0
    print("  ok    Extra npm ecosystem present (passes, ignored)")

    # Case 11: Extra directory entry (e.g. /actions/pr-title in canonical or consumer) is ignored
    extra_dir_content = SREFORGE_CONTENT + """
  - package-ecosystem: github-actions
    directory: "/actions/custom-tool"
    schedule:
      interval: daily
"""
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/sreforge": {"status": "ok", "yaml_content": extra_dir_content}},
    )
    assert proc.returncode == 0, f"Case 11 failed: {proc.stderr}"
    print("  ok    Extra directory entry in consumer (passes, ignored)")

    # Case 12: Cross-owner repository inaccessible (permission / 404 on repo: loud named skip, exits 0)
    proc, summary = run_drift_case(
        script,
        mock_repos={"Sumit1993/mage-memory": {"status": "permission_denied"}},
    )
    assert proc.returncode == 0, f"Case 12 expected exit 0 on permission skip, got {proc.returncode}:\n{proc.stderr}"
    assert "::warning::Skipped Sumit1993/mage-memory" in proc.stdout
    assert "Sumit1993/mage-memory" in summary and "⚠️ Skipped" in summary
    print("  ok    Cross-owner repository inaccessible (loud named skip, exits 0)")

    # Case 13: Missing canonical .github/dependabot.yml in checkout (fails loudly, exit 1)
    proc, summary = run_drift_case(script, remove_canonical=True)
    assert proc.returncode != 0, "Case 13 expected failure on missing canonical file"
    assert "Canonical file .github/dependabot.yml not found" in proc.stderr
    print("  ok    Missing canonical dependabot.yml (fails loudly, exit 1)")

    # Case 14: Malformed canonical YAML (fails loudly, exit 1)
    proc, summary = run_drift_case(script, canonical_content="version: 2\nupdates: [invalid yaml {:")
    assert proc.returncode != 0, "Case 14 expected failure on malformed canonical YAML"
    assert "Failed to parse canonical" in proc.stderr
    print("  ok    Malformed canonical YAML (fails loudly, exit 1)")

    # Case 15: Canonical missing github-actions entry for "/" (fails loudly, exit 1)
    proc, summary = run_drift_case(script, canonical_content=npm_only_content)
    assert proc.returncode != 0, "Case 15 expected failure on canonical missing root actions entry"
    assert "Canonical .github/dependabot.yml missing github-actions entry for directory \"/\"" in proc.stderr
    print("  ok    Canonical missing github-actions root entry (fails loudly, exit 1)")

    # Case 16: Malformed YAML in consumer file (fails loudly naming repo and error, exit 1)
    proc, summary = run_drift_case(
        script,
        mock_repos={"prismalens/prismalens": {"status": "ok", "yaml_content": "version: 2\nupdates: [bad {:"}},
    )
    assert proc.returncode != 0, "Case 16 expected failure on consumer malformed YAML"
    assert "prismalens/prismalens: failed to parse .github/dependabot.yml" in proc.stderr
    print("  ok    Malformed consumer YAML (fails loudly naming repo, exit 1)")

    print(f"\nAll 16 test cases passed successfully.")


if __name__ == "__main__":
    test_suite()
