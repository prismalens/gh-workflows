#!/usr/bin/env python3
"""Behavioural tests for the issue-template sync section of scripts/setup-repo.sh.

Runs the real script (nothing extracted) against a stub `gh` on PATH that answers from
a per-case fixture and logs every invocation. --skip-ruleset --no-labels keeps the run
scoped to the settings check (already at baseline, so no PATCH) and the templates
section, which is what this file covers. Story: #67.

Run: python3 tests/test-setup-repo-templates.py
"""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/setup-repo.sh"

TARGET = "acme/widget"
SOURCE = "acme/.github"  # default derivation: <owner of --repo>/.github

# Settings already at the house baseline, so the settings section makes no PATCH call
# and the run under test is isolated to the templates section.
BASELINE_SETTINGS = {
    "allow_squash_merge": True,
    "allow_merge_commit": False,
    "allow_rebase_merge": False,
    "delete_branch_on_merge": True,
}

GH_STUB_PY = r'''#!/usr/bin/env python3
import base64
import json
import os
import subprocess
import sys

args = sys.argv[1:]

log_path = os.environ.get("GH_STUB_LOG", "")
if log_path:
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(args) + "\n")

cfg_path = os.environ.get("MOCK_CONFIG_FILE", "")
cfg = {}
if cfg_path and os.path.exists(cfg_path):
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

TARGET = cfg.get("target_repo", "")
SOURCE = cfg.get("source_repo", "")


def jq_filter(obj, expr):
    proc = subprocess.run(["jq", "-r", expr], input=json.dumps(obj), capture_output=True, text=True)
    return proc.stdout.rstrip("\n")


def get_flag(name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return None


def get_fields():
    fields = {}
    i = 0
    while i < len(args):
        if args[i] in ("-f", "-F") and i + 1 < len(args):
            k, _, v = args[i + 1].partition("=")
            fields[k] = v
            i += 2
        else:
            i += 1
    return fields


if args and args[0] == "pr" and args[1] == "create":
    print("https://github.com/%s/pull/999" % TARGET)
    sys.exit(0)

if args and args[0] == "api":
    method = get_flag("-X") or "GET"
    endpoint = next((a for a in args[1:] if a.startswith("repos/")), None)
    jq_expr = get_flag("--jq")
    fields = get_fields()

    if endpoint is None:
        sys.stderr.write("gh stub: no endpoint in %r\n" % (args,))
        sys.exit(1)

    def respond(obj):
        if jq_expr:
            print(jq_filter(obj, jq_expr))
        else:
            print(json.dumps(obj))
        sys.exit(0)

    if endpoint == "repos/%s" % TARGET:
        if method == "PATCH":
            sys.exit(0)
        obj = {"full_name": TARGET, "default_branch": cfg.get("default_branch", "main")}
        obj.update(cfg.get("settings", {}))
        respond(obj)

    if endpoint == "repos/%s/contents/.github/ISSUE_TEMPLATE" % TARGET:
        entries = [{"name": n, "type": "file", "sha": sha} for n, sha in cfg.get("target_templates", {}).items()]
        respond(entries)

    tgt_prefix = "repos/%s/contents/.github/ISSUE_TEMPLATE/" % TARGET
    if endpoint.startswith(tgt_prefix):
        if method == "PUT":
            sys.exit(0)
        name = endpoint[len(tgt_prefix):]
        target_templates = cfg.get("target_templates", {})
        if name in target_templates:
            respond({"sha": target_templates[name], "content": base64.b64encode(b"x").decode()})
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)

    if endpoint.startswith("repos/%s/contents/.github/workflows/" % TARGET) or endpoint == "repos/%s/contents/.github/dependabot.yml" % TARGET:
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)

    if endpoint == "repos/%s/git/refs" % TARGET and method == "POST":
        respond({"ref": fields.get("ref", "")})

    head_prefix = "repos/%s/git/ref/heads/" % TARGET
    if endpoint.startswith(head_prefix):
        respond({"object": {"sha": cfg.get("head_sha", "")}})

    if endpoint == "repos/%s/contents/.github/ISSUE_TEMPLATE" % SOURCE:
        if not cfg.get("source_readable", True):
            sys.stderr.write("gh: Not Found (HTTP 404)\n")
            sys.exit(1)
        entries = [{"name": n, "type": "file", "sha": sha} for n, sha in cfg.get("source_templates", {}).items()]
        respond(entries)

    src_prefix = "repos/%s/contents/.github/ISSUE_TEMPLATE/" % SOURCE
    if endpoint.startswith(src_prefix):
        name = endpoint[len(src_prefix):]
        source_templates = cfg.get("source_templates", {})
        if name in source_templates:
            content = base64.b64encode(("content-of-" + name).encode()).decode()
            respond({"sha": source_templates[name], "content": content})
        sys.stderr.write("gh: Not Found (HTTP 404)\n")
        sys.exit(1)

    sys.stderr.write("gh stub: unhandled endpoint %r\n" % (endpoint,))
    sys.exit(1)

sys.stderr.write("gh stub: unhandled call %r\n" % (args,))
sys.exit(1)
'''

DEFAULT_CFG = {
    "target_repo": TARGET,
    "source_repo": SOURCE,
    "default_branch": "main",
    "head_sha": "headsha123",
    "settings": BASELINE_SETTINGS,
    "source_readable": True,
    # bug_report.yml: same sha both sides. feature_request.yml: drifted. config.yml:
    # missing from target. cli_bug_report.yml: target-only, never touched.
    "source_templates": {
        "bug_report.yml": "sha-bug-same",
        "feature_request.yml": "sha-feature-src",
        "config.yml": "sha-config-src",
    },
    "target_templates": {
        "bug_report.yml": "sha-bug-same",
        "feature_request.yml": "sha-feature-TGT-DRIFTED",
        "cli_bug_report.yml": "sha-cli-local",
    },
}


def run_case(script_path, extra_args, cfg_overrides=None):
    cfg = json.loads(json.dumps(DEFAULT_CFG))
    if cfg_overrides:
        cfg.update(cfg_overrides)
    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        binp = tdp / "bin"
        binp.mkdir()
        gh_stub = binp / "gh"
        gh_stub.write_text(GH_STUB_PY, encoding="utf-8")
        gh_stub.chmod(0o755)

        cfg_file = tdp / "cfg.json"
        cfg_file.write_text(json.dumps(cfg), encoding="utf-8")
        log_file = tdp / "gh-calls.log"
        log_file.write_text("", encoding="utf-8")

        env = dict(os.environ)
        env.update(PATH=f"{binp}:{env['PATH']}", MOCK_CONFIG_FILE=str(cfg_file), GH_STUB_LOG=str(log_file))

        proc = subprocess.run(
            ["bash", str(script_path), "--repo", TARGET, "--skip-ruleset", "--no-labels", *extra_args],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
        )
        calls = [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines() if line.strip()]
        return proc, calls


def has_call(calls, *, contains):
    for c in calls:
        if all(tok in c for tok in contains):
            return True
    return False


def count_calls(calls, *, contains):
    return sum(1 for c in calls if all(tok in c for tok in contains))


def test_suite():
    print("=== Testing setup-repo.sh issue-template sync ===")

    # Case 1: report-only run prints same/DRIFTED/MISSING/local correctly, no writes.
    proc, calls = run_case(SCRIPT, [])
    assert proc.returncode == 0, f"Case 1 failed (exit {proc.returncode}):\n{proc.stderr}\n{proc.stdout}"
    assert "same     bug_report.yml" in proc.stdout, proc.stdout
    assert "DRIFTED  feature_request.yml" in proc.stdout, proc.stdout
    assert "MISSING  config.yml" in proc.stdout, proc.stdout
    assert "local    cli_bug_report.yml" in proc.stdout, proc.stdout
    assert not has_call(calls, contains=["-X", "PUT"]), "unexpected PUT in report-only run"
    assert not has_call(calls, contains=["-X", "POST"]), "unexpected POST in report-only run"
    assert not has_call(calls, contains=["-X", "PATCH"]), "unexpected PATCH in report-only run"
    assert not any(c[:2] == ["pr", "create"] for c in calls), "unexpected pr create in report-only run"
    print("  ok    same/drifted/missing/local report correctly, no writes")

    # Case 2: --sync-templates --dry-run makes no write calls at all.
    proc, calls = run_case(SCRIPT, ["--sync-templates", "--dry-run"])
    assert proc.returncode == 0, f"Case 2 failed:\n{proc.stderr}\n{proc.stdout}"
    assert "WOULD write feature_request.yml (drifted)" in proc.stdout, proc.stdout
    assert "WOULD write config.yml (missing)" in proc.stdout, proc.stdout
    assert not has_call(calls, contains=["-X", "PUT"]), "dry-run made a PUT call"
    assert not has_call(calls, contains=["-X", "POST"]), "dry-run made a POST call"
    assert not any(c[:2] == ["pr", "create"] for c in calls), "dry-run opened a PR"
    print("  ok    --sync-templates --dry-run changes nothing")

    # Case 3: --sync-templates writes exactly the drifted and missing files, never the
    # local-only file, with sha only on the drifted PUT, one ref POST, one PR.
    proc, calls = run_case(SCRIPT, ["--sync-templates"])
    assert proc.returncode == 0, f"Case 3 failed:\n{proc.stderr}\n{proc.stdout}"
    ref_posts = count_calls(calls, contains=["-X", "POST", f"repos/{TARGET}/git/refs"])
    assert ref_posts == 1, f"expected exactly one ref POST, got {ref_posts}"
    put_feature = [c for c in calls if "-X" in c and "PUT" in c and f"repos/{TARGET}/contents/.github/ISSUE_TEMPLATE/feature_request.yml" in c]
    put_config = [c for c in calls if "-X" in c and "PUT" in c and f"repos/{TARGET}/contents/.github/ISSUE_TEMPLATE/config.yml" in c]
    assert len(put_feature) == 1, f"expected one PUT for feature_request.yml, got {len(put_feature)}"
    assert len(put_config) == 1, f"expected one PUT for config.yml, got {len(put_config)}"
    assert any(f.startswith("sha=") for f in put_feature[0]), "drifted PUT missing sha field"
    assert not any(f.startswith("sha=") for f in put_config[0]), "missing-file PUT should carry no sha field"
    # has_call tests exact argv elements (`tok in c` over a list), and the script
    # never passes a bare "cli_bug_report.yml" -- only the full endpoint below, as
    # put_feature/put_config above already match. The old bare-name assertion could
    # never fail (CR #173, thread 4000816215).
    cli_endpoint = f"repos/{TARGET}/contents/.github/ISSUE_TEMPLATE/cli_bug_report.yml"
    assert not has_call(calls, contains=[cli_endpoint]), "sync touched the local-only file"
    pr_creates = sum(1 for c in calls if c[:2] == ["pr", "create"])
    assert pr_creates == 1, f"expected exactly one pr create, got {pr_creates}"
    print("  ok    --sync-templates writes drifted+missing only, sha only on drifted, one PR")

    # Case 4: an unreadable source warns and the run still exits 0.
    proc, calls = run_case(SCRIPT, [], cfg_overrides={"source_readable": False})
    assert proc.returncode == 0, f"Case 4 expected exit 0, got {proc.returncode}:\n{proc.stderr}\n{proc.stdout}"
    assert "WARNING: cannot read" in proc.stdout, proc.stdout
    assert "skipping" in proc.stdout, proc.stdout
    assert not has_call(calls, contains=["-X", "PUT"]), "unreadable source still wrote something"
    print("  ok    unreadable source warns once, exits 0")

    # Case 5: only drifted files, no missing files -- MISSING_FILES is empty and
    # set -u is active, so the unguarded loop at the old line 342 (and the dry-run
    # print at 327) would raise "unbound variable" on bash below 4.4
    # (CR #173, thread 4000816192).
    drifted_only_cfg = {
        "source_templates": {
            "bug_report.yml": "sha-bug-same",
            "feature_request.yml": "sha-feature-src",
        },
        "target_templates": {
            "bug_report.yml": "sha-bug-same",
            "feature_request.yml": "sha-feature-TGT-DRIFTED",
            "cli_bug_report.yml": "sha-cli-local",
        },
    }
    proc, calls = run_case(SCRIPT, ["--sync-templates"], cfg_overrides=drifted_only_cfg)
    assert proc.returncode == 0, f"Case 5 failed (exit {proc.returncode}):\n{proc.stderr}\n{proc.stdout}"
    assert "unbound variable" not in proc.stderr, proc.stderr
    put_feature = [c for c in calls if "-X" in c and "PUT" in c and f"repos/{TARGET}/contents/.github/ISSUE_TEMPLATE/feature_request.yml" in c]
    assert len(put_feature) == 1, f"expected one PUT for feature_request.yml, got {len(put_feature)}"
    pr_creates = sum(1 for c in calls if c[:2] == ["pr", "create"])
    assert pr_creates == 1, f"expected exactly one pr create, got {pr_creates}"
    print("  ok    drifted-only sync (no missing files) does not raise unbound variable")

    # Case 6: the reverse -- only missing files, no drifted files. DRIFTED_FILES is
    # empty; the unguarded loop at the old line 334 (and dry-run print at 326) is
    # the one that would fail.
    missing_only_cfg = {
        "source_templates": {
            "bug_report.yml": "sha-bug-same",
            "config.yml": "sha-config-src",
        },
        "target_templates": {
            "bug_report.yml": "sha-bug-same",
            "cli_bug_report.yml": "sha-cli-local",
        },
    }
    proc, calls = run_case(SCRIPT, ["--sync-templates"], cfg_overrides=missing_only_cfg)
    assert proc.returncode == 0, f"Case 6 failed (exit {proc.returncode}):\n{proc.stderr}\n{proc.stdout}"
    assert "unbound variable" not in proc.stderr, proc.stderr
    put_config = [c for c in calls if "-X" in c and "PUT" in c and f"repos/{TARGET}/contents/.github/ISSUE_TEMPLATE/config.yml" in c]
    assert len(put_config) == 1, f"expected one PUT for config.yml, got {len(put_config)}"
    pr_creates = sum(1 for c in calls if c[:2] == ["pr", "create"])
    assert pr_creates == 1, f"expected exactly one pr create, got {pr_creates}"
    print("  ok    missing-only sync (no drifted files) does not raise unbound variable")

    print("\nAll 6 test cases passed successfully.")


if __name__ == "__main__":
    test_suite()
