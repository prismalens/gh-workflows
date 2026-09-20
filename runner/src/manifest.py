"""Standalone extraction of the two inline Python programs the
`.github/workflows/claude-code-review.yml` workflow runs to build
`.claude-review-manifest.json` and `.claude-review.diff` before a review.

Source: the "Build review manifest" step (id: manifest, originally
claude-code-review.yml lines ~1732-2031) and the "Build review context" step
(id: context, originally lines ~2040-2731), copied verbatim into
`build_review_manifest()` and `build_review_context()` below -- wrapped, not
rewritten. A step in between, "Filter review paths" (id: filter_paths,
lines ~2735-2910), was read in full while extracting this: it re-fetches the
PR file list itself and rewrites the *incremental range file*
(.claude-incremental-range.json or /tmp/incremental-range.json) in place to
drop excluded files, and writes /tmp/claude-path-filters-result.json plus its
own GITHUB_OUTPUT keys. It does NOT touch .claude-review-manifest.json or
.claude-review.diff, so nothing from it needed copying here.

Env vars read (same as the workflow steps):
  build_review_manifest(): GH_TOKEN, REPO, PR, MODE, HEAD_SHA, PATH_FILTERS,
    CONFIG_RESOLUTION, MAX_REVIEWABLE_LINES, MAX_FILE_LINES, CONTEXT_LINES,
    plus GITHUB_WORKSPACE (defaults to "." -- the script's cwd) and
    GITHUB_OUTPUT (see _github_output_to_stderr below).
  build_review_context(): GH_TOKEN, REPO, PR, HEAD_SHA, BASE_SHA,
    CONFIG_RESOLUTION, LANGUAGE_MAP, TOOL_FINDINGS, ISSUE_BYTE_BUDGET,
    ISSUE_TOTAL_BYTE_BUDGET, BASE_PR_NUMBER, BASE_PR_TITLE, plus
    GITHUB_WORKSPACE and GITHUB_OUTPUT as above.

External commands: both programs shell out to `gh` (gh api ...), including
one `gh api ... --jq ".head.sha"` call inside build_review_manifest(). That
`--jq` is gh's own bundled JSON query engine (gojq), not the system `jq`
binary -- no external jq is invoked anywhere in either program. This machine
has no `jq`, so this matters: DO NOT substitute a `jq` shell-out for it.
build_review_manifest() also runs `git grep` and build_review_context() runs
`git show`, plus (best-effort, all optional) `actionlint` (downloaded via
curl+sha256sum+tar if not already on PATH or at ./actionlint), `shellcheck`,
`node_modules/.bin/tsc`, `node_modules/.bin/eslint`, `node_modules/.bin/biome`.

Both programs already guard their own GITHUB_OUTPUT writes with
`if github_output:` and their only annotations are plain `print("::warning::"...)`
/ `print("::error::"...)` calls, which are harmless stdout text with or
without GITHUB_STEP_SUMMARY or GITHUB_OUTPUT set -- neither program reads or
writes GITHUB_STEP_SUMMARY at all. The one thing worth changing from a pure
copy/paste is that, outside Actions, GITHUB_OUTPUT is normally unset and the
original code's guard makes that a silent no-op: main() below preserves the
values instead by pointing GITHUB_OUTPUT at a scratch file for the duration
of each call, when it wasn't already set, and relaying whatever landed there
to stderr. Neither function's body is touched to do this.
"""

import contextlib
import os
import sys
import tempfile


@contextlib.contextmanager
def _github_output_to_stderr(label):
    """See module docstring. No-ops (yields straight through) when the caller
    already set GITHUB_OUTPUT, e.g. because this script is itself running
    inside a GitHub Actions step."""
    existing = os.environ.get("GITHUB_OUTPUT")
    if existing:
        yield
        return
    fd, path = tempfile.mkstemp(prefix="manifest-github-output-")
    os.close(fd)
    os.environ["GITHUB_OUTPUT"] = path
    try:
        yield
    finally:
        try:
            with open(path, "r", encoding="utf-8") as f:
                contents = f.read()
        except OSError:
            contents = ""
        os.environ.pop("GITHUB_OUTPUT", None)
        try:
            os.remove(path)
        except OSError:
            pass
        if contents.strip():
            print(f"--- {label}: GITHUB_OUTPUT (unset; relayed to stderr) ---", file=sys.stderr)
            sys.stderr.write(contents if contents.endswith("\n") else contents + "\n")


def build_review_manifest():
    """Verbatim body of the "Build review manifest" step's inline Python
    (claude-code-review.yml, step id `manifest`, originally lines ~1752-2030
    inside the `python3 - <<'PY' ... PY` heredoc). Writes
    .claude-review-manifest.json and .claude-review.diff into the workspace."""
    import fnmatch
    import json
    import os
    import pathlib
    import subprocess
    import sys

    # Kept in sync with "Filter review paths" by hand; the two steps read the
    # same config output but fetch and classify the file list independently,
    # so each is testable against its own stubbed `gh`. Story: #105.
    DEFAULT_PATH_FILTERS = [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "Cargo.lock",
        "poetry.lock",
        "go.sum",
        "dist/**",
        "build/**",
        "vendor/**",
        "**/__snapshots__/**",
        "*.min.js",
        "*.min.css",
        "**/node_modules/**",
    ]

    def matches_pattern(path: str, pattern: str) -> bool:
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            if path == prefix or path.startswith(prefix + "/"):
                return True
            if fnmatch.fnmatch(path, pattern):
                return True
        elif fnmatch.fnmatch(path, pattern):
            return True
        return False

    # Same override semantics as "Filter review paths" (#105): repo config or
    # org defaults REPLACE the default list; anything else falls back to it.
    config_resolution_raw = os.environ.get("CONFIG_RESOLUTION", "{}")
    try:
        config_res = json.loads(config_resolution_raw) if config_resolution_raw else {}
        pf_source = config_res.get("sources", {}).get("path_filters", "workflow default")
    except Exception:
        pf_source = "workflow default"

    raw_filters = os.environ.get("PATH_FILTERS", "")
    if pf_source in ("repo config", "org defaults"):
        try:
            path_filters = json.loads(raw_filters) if raw_filters else []
        except Exception:
            path_filters = []
    elif raw_filters and raw_filters not in ("[]", '""'):
        try:
            path_filters = json.loads(raw_filters)
        except Exception:
            path_filters = DEFAULT_PATH_FILTERS
    else:
        path_filters = DEFAULT_PATH_FILTERS

    def as_int(raw, default=0):
        raw = (raw or "").strip()
        if not raw:
            return default
        try:
            return int(float(raw))
        except Exception:
            return default

    max_reviewable_lines = as_int(os.environ.get("MAX_REVIEWABLE_LINES", ""), 6000)
    max_file_lines = as_int(os.environ.get("MAX_FILE_LINES", ""), 2000)

    mode = os.environ.get("MODE", "")
    repo = os.environ.get("REPO", "")
    pr = os.environ.get("PR", "")
    is_incremental = (mode == "incremental")

    files_data = []
    if is_incremental:
        range_file = None
        for p in [pathlib.Path(".claude-incremental-range.json"), pathlib.Path("/tmp/incremental-range.json")]:
            if p.exists():
                range_file = p
                break
        if range_file is not None:
            try:
                with open(range_file, "r", encoding="utf-8") as f:
                    range_data = json.load(f)
                files_data = range_data.get("files", [])
            except Exception as e:
                print(f"::warning::Failed to read incremental range file for manifest: {e}")
    else:
        if repo and pr:
            # `/pulls/{pr}/files` is not pinned to a commit -- it always reflects
            # the PR's CURRENT head. "Checkout repository" (the previous step)
            # already pinned HEAD_SHA to disk; a push landing in the gap between
            # that checkout and this fetch would make the manifest/diff built
            # below describe a different commit than what is on disk and than
            # what the round's own baseline math (the liveness marker's `sha=`)
            # assumes was reviewed -- a live-diff-vs-checked-out-code mismatch
            # while still reporting success. Confirm the head has not moved.
            head_sha = os.environ.get("HEAD_SHA", "")
            if head_sha:
                live_res = subprocess.run(
                    ["gh", "api", f"repos/{repo}/pulls/{pr}", "--jq", ".head.sha"],
                    capture_output=True, text=True,
                )
                if live_res.returncode != 0:
                    print(f"::warning::Could not confirm PR #{pr}'s current head before building the manifest: {live_res.stderr.strip()}")
                else:
                    live_head = live_res.stdout.strip()
                    if live_head and live_head != head_sha:
                        print(
                            f"::error::Build review manifest: PR #{pr} head moved from {head_sha} to "
                            f"{live_head} between checkout and this step; refusing to build a manifest "
                            f"for a diff that may not match the checked-out commit."
                        )
                        raise SystemExit(1)

            cmd = ["gh", "api", f"repos/{repo}/pulls/{pr}/files", "--paginate", "--slurp"]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                try:
                    pages = json.loads(res.stdout)
                    files_data = [f for page in pages for f in page]
                except Exception as e:
                    print(f"::warning::Failed to parse PR files JSON for manifest: {e}")
                    raise SystemExit("Cannot build review manifest without the PR file list")
            else:
                err = res.stderr.strip() if res.stderr else f"exit code {res.returncode}"
                print(f"::error::Failed to list PR files for manifest: {err}")
                raise SystemExit(1)

    STATUS_MAP = {
        "added": "added",
        "removed": "deleted",
        "modified": "modified",
        "renamed": "renamed",
        "changed": "modified",
        "copied": "modified",
        "unchanged": "modified",
    }

    def git_grep_paths(needle: str):
        if not needle:
            return []
        try:
            res = subprocess.run(
                ["git", "grep", "-l", "-F", "--", needle],
                capture_output=True, text=True,
            )
        except Exception:
            return []
        # 0 = matches found, 1 = no matches. Anything else is a real error
        # (not a repository, binary path confusion, etc.) and is treated as
        # "could not determine", never as a silent empty list.
        if res.returncode not in (0, 1):
            print(f"::warning::git grep failed for {needle!r}: {res.stderr.strip()}")
            return []
        return [line.strip() for line in res.stdout.splitlines() if line.strip()]

    def strip_extension(path: str) -> str:
        base = path.rsplit("/", 1)[-1]
        if "." in base:
            stem = base.rsplit(".", 1)[0]
            return path[: -(len(base))] + stem
        return path

    def compute_references(path: str):
        if not path:
            return []
        hits = set(git_grep_paths(path))
        stripped = strip_extension(path)
        if stripped != path:
            hits.update(git_grep_paths(stripped))
        return sorted(hits)

    manifest_entries = []
    diff_parts = []
    reviewable_lines_total = 0

    for item in files_data:
        if not isinstance(item, dict):
            continue
        fname = item.get("filename", "")
        raw_status = item.get("status", "modified")
        status = STATUS_MAP.get(raw_status, "modified")
        additions = item.get("additions", 0) or 0
        deletions = item.get("deletions", 0) or 0
        previous_path = item.get("previous_filename") or None
        patch = item.get("patch")

        # GitHub omits `patch` for binary content and for an unchanged rename
        # alike; only the latter carries status "renamed", which is why that
        # status is checked first and never reclassified as binary.
        if patch is None and status != "renamed":
            status = "binary"

        filtered_by = None
        for pat in path_filters:
            if matches_pattern(fname, pat):
                filtered_by = pat
                break

        references = []
        if status == "deleted":
            references = compute_references(fname)
        elif status == "renamed":
            references = compute_references(previous_path or fname)

        reviewable_status = status in ("added", "modified") or (
            status == "renamed" and (additions > 0 or deletions > 0)
        )
        file_lines = additions + deletions

        if filtered_by is None and reviewable_status and max_file_lines > 0 and file_lines > max_file_lines:
            filtered_by = "oversized"

        counted = filtered_by is None and reviewable_status
        if counted:
            reviewable_lines_total += file_lines

        manifest_entries.append({
            "path": fname,
            "status": status,
            "previous_path": previous_path,
            "additions": additions,
            "deletions": deletions,
            "filtered_by": filtered_by,
            "references": references,
        })

        if counted and patch:
            diff_parts.append(f"diff --git a/{fname} b/{fname}\n--- a/{fname}\n+++ b/{fname}\n{patch}\n")

    workspace = pathlib.Path(os.environ.get("GITHUB_WORKSPACE", "."))
    manifest_path = workspace / ".claude-review-manifest.json"
    diff_path = workspace / ".claude-review.diff"

    # "files" holds this step's own output; "context" is filled in by the next step,
    # "Build review context" (#143-#147), which reads this same file back and rewrites
    # it. Both live in one manifest because the invariant is the same for both: the
    # caller fetches, the agent only reads.
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump({"files": manifest_entries, "context": {}}, f, indent=2)
        f.write("\n")

    with open(diff_path, "w", encoding="utf-8") as f:
        f.write("\n".join(diff_parts))
        if diff_parts:
            f.write("\n")

    # Context lines from declared public repositories add to reviewable_lines (#90).
    context_lines = as_int(os.environ.get("CONTEXT_LINES", ""), 0)
    reviewable_lines_total += context_lines

    # `@claude full review` is a person asking for this exact round anyway,
    # so it overrides the cap for that one round (#105). The round is still
    # counted as an override on the telemetry row so an operator repeatedly
    # overriding a real problem stays visible.
    override_active = (mode == "review-full")
    would_refuse = max_reviewable_lines > 0 and reviewable_lines_total > max_reviewable_lines
    refused = would_refuse and not override_active
    size_override = would_refuse and override_active

    print(
        f"review manifest: {len(manifest_entries)} file(s), {reviewable_lines_total} reviewable "
        f"line(s) (max_reviewable_lines={max_reviewable_lines or 'disabled'}, "
        f"max_file_lines={max_file_lines or 'disabled'}), refused={refused}, size_override={size_override}"
    )

    github_output = os.environ.get("GITHUB_OUTPUT", "")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as f:
            f.write(f"reviewable_lines={reviewable_lines_total}\n")
            f.write(f"max_reviewable_lines={max_reviewable_lines}\n")
            f.write(f"max_file_lines={max_file_lines}\n")
            f.write(f"refused={'true' if refused else 'false'}\n")
            f.write(f"size_override={'true' if size_override else 'false'}\n")


def build_review_context():
    """Verbatim body of the "Build review context" step's inline Python
    (claude-code-review.yml, step id `context`, originally lines ~2061-2730
    inside the `python3 - <<'PY' ... PY` heredoc). Reads back
    .claude-review-manifest.json, fills in its "context" object, and
    rewrites the file."""
    import json
    import os
    import pathlib
    import re
    import shutil
    import subprocess

    try:
        import yaml
    except ImportError:
        yaml = None

    workspace = pathlib.Path(os.environ.get("GITHUB_WORKSPACE", "."))
    manifest_path = workspace / ".claude-review-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"::error::Build review context: could not read {manifest_path}: {e}")
        raise SystemExit(1)
    manifest_files = manifest.get("files", [])

    repo = os.environ.get("REPO", "")
    pr = os.environ.get("PR", "")
    head_sha = os.environ.get("HEAD_SHA", "")
    base_sha = os.environ.get("BASE_SHA", "")


    def as_int(raw, default=0):
        raw = (raw or "").strip()
        if not raw:
            return default
        try:
            return int(float(raw))
        except Exception:
            return default


    def run_gh(args, timeout=20):
        # A failed or hung `gh` call must never take the round down with it (#143/#145):
        # every caller here treats a non-zero return as "could not fetch" and records it.
        class _Failed:
            returncode = 1
            stdout = ""
            stderr = "subprocess failed or timed out"

        try:
            return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        except Exception:
            return _Failed()


    config_resolution_raw = os.environ.get("CONFIG_RESOLUTION", "{}")
    try:
        config_res = json.loads(config_resolution_raw) if config_resolution_raw else {}
        cfg_sources = config_res.get("sources", {})
    except Exception:
        cfg_sources = {}

    notes = []  # short human-readable fragments surfaced on the liveness comment

    # ---------------------------------------------------------------------------
    # #144 -- profile: languages, package managers, scripts, ci, config_files.
    # Detection is by file presence and extension only, never an AST or a language
    # server. Unknown extensions count as "other" and are never dropped.
    # ---------------------------------------------------------------------------
    DEFAULT_LANGUAGE_MAP = {
        "ts": "TypeScript", "tsx": "TypeScript", "mts": "TypeScript", "cts": "TypeScript",
        "js": "JavaScript", "jsx": "JavaScript", "mjs": "JavaScript", "cjs": "JavaScript",
        "sh": "Shell", "bash": "Shell",
    }
    raw_language_map = os.environ.get("LANGUAGE_MAP", "")
    lm_source = cfg_sources.get("language_map", "workflow default")
    if lm_source in ("repo config", "org defaults") and raw_language_map not in ("", "{}"):
        try:
            language_map = json.loads(raw_language_map)
        except Exception:
            language_map = DEFAULT_LANGUAGE_MAP
    else:
        language_map = DEFAULT_LANGUAGE_MAP


    def classify_language(path):
        base = path.rsplit("/", 1)[-1]
        if "." not in base:
            return "other"
        ext = base.rsplit(".", 1)[-1].lower()
        return language_map.get(ext, "other")


    languages = {}
    for entry in manifest_files:
        lang = classify_language(entry.get("path", ""))
        languages[lang] = languages.get(lang, 0) + 1

    LOCKFILE_TO_MANAGER = {
        "package-lock.json": "npm",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "Cargo.lock": "cargo",
        "poetry.lock": "poetry",
        "go.sum": "go",
    }
    package_managers = {}
    check_dirs = {"."} | {str(pathlib.Path(e.get("path", "")).parent) for e in manifest_files}
    for d in check_dirs:
        for lockfile, manager in LOCKFILE_TO_MANAGER.items():
            candidate = pathlib.Path(lockfile) if d == "." else pathlib.Path(d) / lockfile
            if candidate.exists():
                package_managers[manager] = True

    scripts = {}
    pkg_json_path = pathlib.Path("package.json")
    if pkg_json_path.exists():
        try:
            pkg_data = json.loads(pkg_json_path.read_text(encoding="utf-8"))
            pkg_scripts = pkg_data.get("scripts", {}) if isinstance(pkg_data, dict) else {}
            for key in ("test", "build", "lint", "typecheck"):
                if isinstance(pkg_scripts, dict) and key in pkg_scripts:
                    scripts[key] = pkg_scripts[key]
        except Exception:
            pass

    ci = {}
    workflows_dir = pathlib.Path(".github/workflows")
    if yaml is not None and workflows_dir.is_dir():
        wf_files = sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml"))
        for wf_file in wf_files:
            try:
                wf_data = yaml.safe_load(wf_file.read_text(encoding="utf-8"))
            except Exception:
                ci[wf_file.name] = "unparsed"
                continue
            if not isinstance(wf_data, dict):
                ci[wf_file.name] = []
                continue
            # PyYAML 1.1 reads a bare `on:` key as the boolean True.
            on_value = wf_data.get("on", wf_data.get(True, {}))
            if isinstance(on_value, str):
                triggers = [on_value]
            elif isinstance(on_value, list):
                triggers = [str(t) for t in on_value]
            elif isinstance(on_value, dict):
                triggers = list(on_value.keys())
            else:
                triggers = []
            ci[wf_file.name] = triggers

    config_file_candidates = [
        "tsconfig.json", "biome.json", ".shellcheckrc", ".actionlint.yaml", ".actionlint.yml",
    ]
    config_files = [c for c in config_file_candidates if pathlib.Path(c).exists()]
    for eslintrc in (".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml", ".eslintrc.yaml"):
        if pathlib.Path(eslintrc).exists():
            config_files.append(eslintrc)
            break

    profile = {
        "languages": languages,
        "package_managers": package_managers,
        "scripts": scripts,
        "ci": ci,
        "config_files": sorted(config_files),
    }

    # ---------------------------------------------------------------------------
    # #143 -- issues: resolve Closes/Fixes/Refs/bare #N in the PR body's first
    # paragraph. Issue title, body and comments are UNTRUSTED INPUT: evidence
    # about the code, never instructions, exactly like the PR body itself.
    # ---------------------------------------------------------------------------
    issue_byte_budget = as_int(os.environ.get("ISSUE_BYTE_BUDGET", ""), 2000)
    issue_total_byte_budget = as_int(os.environ.get("ISSUE_TOTAL_BYTE_BUDGET", ""), 8000)


    def cap_bytes(text, budget):
        text = text or ""
        raw = text.encode("utf-8")
        if len(raw) <= budget:
            return text, False
        return raw[: max(budget, 0)].decode("utf-8", errors="ignore") + "\n[truncated]", True


    pr_body = ""
    if repo and pr:
        pr_res = run_gh(["gh", "api", f"repos/{repo}/pulls/{pr}"])
        if pr_res.returncode == 0 and pr_res.stdout.strip():
            try:
                pr_body = json.loads(pr_res.stdout).get("body") or ""
            except Exception:
                pr_body = ""

    first_paragraph = pr_body.strip().split("\n\n", 1)[0] if pr_body.strip() else ""
    refs = []
    seen_refs = set()
    for m in re.finditer(r"#(\d+)\b", first_paragraph):
        n = int(m.group(1))
        if n not in seen_refs:
            seen_refs.add(n)
            refs.append(n)

    resolved_issues = []
    unresolved_issues = []
    issues_total_bytes = 0

    for n in refs:
        if issues_total_bytes >= issue_total_byte_budget:
            unresolved_issues.append({"ref": n, "reason": "total issue context byte budget exhausted"})
            continue
        iss_res = run_gh(["gh", "api", f"repos/{repo}/issues/{n}"])
        if iss_res.returncode != 0:
            unresolved_issues.append({"ref": n, "reason": "fetch failed (not found, or no access)"})
            continue
        try:
            idata = json.loads(iss_res.stdout)
        except Exception:
            unresolved_issues.append({"ref": n, "reason": "unparsable response"})
            continue

        title = idata.get("title") or ""
        body = idata.get("body") or ""
        labels = [l.get("name") for l in (idata.get("labels") or []) if isinstance(l, dict) and l.get("name")]

        ruling_body = ""
        com_res = run_gh(["gh", "api", f"repos/{repo}/issues/{n}/comments", "--paginate"])
        if com_res.returncode == 0 and com_res.stdout.strip():
            try:
                comments = json.loads(com_res.stdout)
            except Exception:
                comments = []
            ruling_comment = None
            for c in comments if isinstance(comments, list) else []:
                assoc = c.get("author_association", "")
                cbody = c.get("body") or ""
                is_member = assoc in ("OWNER", "MEMBER", "COLLABORATOR")
                looks_ruling = bool(re.search(r"^#{1,6}\s*(Spec|Ruling)\b", cbody, re.MULTILINE | re.IGNORECASE))
                if is_member or looks_ruling:
                    ruling_comment = c  # comments arrive oldest-first, so the last match is newest
            if ruling_comment is not None:
                ruling_body = ruling_comment.get("body") or ""

        title_c, t_trunc = cap_bytes(title, issue_byte_budget)
        remaining = max(issue_byte_budget - len(title_c.encode("utf-8")), 0)
        body_c, b_trunc = cap_bytes(body, remaining)
        remaining = max(remaining - len(body_c.encode("utf-8")), 0)
        ruling_c, r_trunc = cap_bytes(ruling_body, remaining) if ruling_body else ("", False)

        entry = {
            "number": n,
            "title": title_c,
            "body": body_c,
            "labels": labels,
            "ruling_comment": ruling_c or None,
            "url": idata.get("html_url", ""),
            "truncated": t_trunc or b_trunc or r_trunc,
        }
        entry_bytes = len(json.dumps(entry).encode("utf-8"))
        # Applies to the FIRST issue too (defect hunt): a per-issue budget
        # (issue_byte_budget) can be configured larger than this total, in which
        # case a bug that only checked "resolved_issues and ..." let exactly one
        # oversized entry through regardless of the configured ceiling -- an
        # honest "budget exhausted" report is required even when it means zero
        # issues resolved, never a silent one-entry overrun.
        if issues_total_bytes + entry_bytes > issue_total_byte_budget:
            unresolved_issues.append({"ref": n, "reason": "total issue context byte budget exhausted"})
            continue
        resolved_issues.append(entry)
        issues_total_bytes += entry_bytes

    issues_context = {"resolved": resolved_issues, "unresolved": unresolved_issues}
    if unresolved_issues:
        notes.append(
            f"{len(unresolved_issues)} issue reference(s) in the PR body could not be resolved "
            f"({', '.join('#' + str(u['ref']) for u in unresolved_issues[:5])})"
        )

    # ---------------------------------------------------------------------------
    # #145 -- ci_failures: the lane never waits for CI; it reads whatever the head
    # already reports. Third-party checks contribute name/conclusion only, never
    # their output. A log tail is untrusted text, same rule as the PR body.
    # ---------------------------------------------------------------------------
    CI_LOG_BYTE_BUDGET = 4000
    ci_failure_entries = []
    ci_pending = []
    ci_fetch_failed = False

    if repo and head_sha:
        cr_res = run_gh(["gh", "api", f"repos/{repo}/commits/{head_sha}/check-runs", "--paginate"])
        if cr_res.returncode != 0:
            ci_fetch_failed = True
        else:
            try:
                payload = json.loads(cr_res.stdout) if cr_res.stdout.strip() else {}
            except Exception:
                payload = {}
            check_runs = payload.get("check_runs", []) if isinstance(payload, dict) else []
            FAILURE_CONCLUSIONS = {"failure", "timed_out", "action_required", "cancelled"}
            for cr in check_runs if isinstance(check_runs, list) else []:
                if not isinstance(cr, dict):
                    continue
                # This round's own check cannot have a conclusion yet; excluding it by name
                # stops the running review from reading itself back as a false pending.
                if cr.get("name") == "Claude Code Review":
                    continue
                name = cr.get("name", "")
                status = cr.get("status", "")
                conclusion = cr.get("conclusion")
                if status != "completed":
                    ci_pending.append(name)
                    continue
                if conclusion in FAILURE_CONCLUSIONS:
                    app_slug = (cr.get("app") or {}).get("slug", "")
                    fail_entry = {"name": name, "conclusion": conclusion}
                    if app_slug == "github-actions":
                        details_url = cr.get("details_url") or ""
                        job_match = re.search(r"/job/(\d+)", details_url)
                        log_tail = None
                        if job_match:
                            log_res = run_gh(["gh", "api", f"repos/{repo}/actions/jobs/{job_match.group(1)}/logs"])
                            if log_res.returncode == 0 and log_res.stdout:
                                tail = log_res.stdout.encode("utf-8", errors="ignore")[-CI_LOG_BYTE_BUDGET:]
                                log_tail = tail.decode("utf-8", errors="ignore")
                        fail_entry["log_tail"] = log_tail
                        if log_tail is None:
                            fail_entry["log_fetch_failed"] = True
                    else:
                        fail_entry["log_tail"] = None
                        fail_entry["note"] = "third-party check: name and conclusion only, never its output"
                    ci_failure_entries.append(fail_entry)

    if ci_fetch_failed:
        ci_context = {"state": "unknown", "failures": [], "pending": [], "fetch_failed": True}
        notes.append("CI check state could not be read")
    elif ci_failure_entries:
        ci_context = {"state": "failure", "failures": ci_failure_entries, "pending": ci_pending}
        notes.append(f"{len(ci_failure_entries)} CI check(s) failing on this head")
    elif ci_pending:
        ci_context = {"state": "pending", "failures": [], "pending": ci_pending}
        notes.append(f"{len(ci_pending)} CI check(s) still pending ({', '.join(ci_pending[:5])})")
    else:
        ci_context = {"state": "green", "failures": [], "pending": []}

    # ---------------------------------------------------------------------------
    # #147 -- dependencies: a lockfile change becomes an added/removed/bumped
    # delta, never a raw diff. Unknown formats say `unparsed`, never a guess.
    # npm (package-lock.json v2/v3) is the one format parsed for real so far;
    # yarn.lock, pnpm-lock.yaml, Cargo.lock, poetry.lock and go.sum each need
    # their own parser and are declared unparsed until one is written.
    # ---------------------------------------------------------------------------
    LOCKFILE_FORMATS = {
        "package-lock.json": "npm",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "Cargo.lock": "cargo",
        "poetry.lock": "poetry",
        "go.sum": "go",
    }


    def parse_npm_lock(text):
        data = json.loads(text)
        pkgs = {}
        packages = data.get("packages")
        if isinstance(packages, dict):
            for path, meta in packages.items():
                if not path.startswith("node_modules/") or not isinstance(meta, dict):
                    continue
                name = path[len("node_modules/"):]
                version = meta.get("version")
                if not version:
                    continue
                is_direct = "/node_modules/" not in name
                prev = pkgs.get(name)
                if prev is None or (is_direct and not prev["direct"]):
                    pkgs[name] = {"version": version, "direct": is_direct}
        else:
            for name, meta in (data.get("dependencies") or {}).items():
                if isinstance(meta, dict) and meta.get("version"):
                    pkgs[name] = {"version": meta["version"], "direct": True}
        return pkgs


    def bump_kind(old, new):
        def parts(v):
            nums = re.findall(r"\d+", v.split("-", 1)[0])
            nums = [int(x) for x in nums[:3]]
            return nums + [0] * (3 - len(nums))

        try:
            o, n = parts(old), parts(new)
        except Exception:
            return "unknown"
        if o[0] != n[0]:
            return "major"
        if o[1] != n[1]:
            return "minor"
        if o[2] != n[2]:
            return "patch"
        return "none"


    dependencies_context = {"lockfile": None, "added": [], "removed": [], "bumped": [], "unparsed": []}
    changed_paths = [e.get("path", "") for e in manifest_files]
    lockfile_path = next((p for p in changed_paths if pathlib.Path(p).name in LOCKFILE_FORMATS), None)

    if lockfile_path:
        fmt = LOCKFILE_FORMATS[pathlib.Path(lockfile_path).name]
        dependencies_context["lockfile"] = lockfile_path
        dependencies_context["format"] = fmt
        if fmt == "npm":
            before_res = subprocess.run(["git", "show", f"{base_sha}:{lockfile_path}"], capture_output=True, text=True)
            before_text = before_res.stdout if before_res.returncode == 0 else ""
            after_path = pathlib.Path(lockfile_path)
            after_text = after_path.read_text(encoding="utf-8") if after_path.exists() else ""
            try:
                before_pkgs = parse_npm_lock(before_text) if before_text.strip() else {}
                after_pkgs = parse_npm_lock(after_text) if after_text.strip() else {}
                for name, meta in after_pkgs.items():
                    if name not in before_pkgs:
                        dependencies_context["added"].append(
                            {"name": name, "version": meta["version"], "direct": meta["direct"]}
                        )
                    elif before_pkgs[name]["version"] != meta["version"]:
                        dependencies_context["bumped"].append({
                            "name": name,
                            "from": before_pkgs[name]["version"],
                            "to": meta["version"],
                            "kind": bump_kind(before_pkgs[name]["version"], meta["version"]),
                            "direct": meta["direct"],
                        })
                for name, meta in before_pkgs.items():
                    if name not in after_pkgs:
                        dependencies_context["removed"].append(
                            {"name": name, "version": meta["version"], "direct": meta["direct"]}
                        )
            except Exception as e:
                dependencies_context["unparsed"] = [lockfile_path]
                print(f"::warning::dependency delta: failed to parse {lockfile_path}: {e}")
        else:
            dependencies_context["unparsed"] = [lockfile_path]

    if dependencies_context["unparsed"]:
        notes.append(f"dependency lockfile format not parsed: {dependencies_context['unparsed'][0]}")

    # ---------------------------------------------------------------------------
    # #146 -- tool_findings: deterministic tools run on changed files only, the
    # model confirms or discards each finding. Every tool is time-boxed; one that
    # cannot run is recorded and never fails the round. No tool here needs
    # network to analyse the diff, and none installs or executes repository
    # code -- tsc/eslint/biome only run against a checkout that already has them.
    # ---------------------------------------------------------------------------
    TOOL_TIMEOUT_SECONDS = 30
    raw_tool_findings = os.environ.get("TOOL_FINDINGS", "")
    tf_source = cfg_sources.get("tool_findings", "workflow default")
    DEFAULT_TOOLS = ["actionlint", "shellcheck", "tsc", "eslint", "biome"]
    if tf_source in ("repo config", "org defaults"):
        try:
            enabled_tools = json.loads(raw_tool_findings) if raw_tool_findings not in ("", "[]") else []
        except Exception:
            enabled_tools = DEFAULT_TOOLS
    else:
        enabled_tools = DEFAULT_TOOLS

    tools_ran = []
    tools_skipped = []
    tool_findings_list = []

    changed_workflow_files = [
        p for p in changed_paths if p.startswith(".github/workflows/") and pathlib.Path(p).exists()
    ]
    changed_sh_files = [p for p in changed_paths if p.endswith(".sh") and pathlib.Path(p).exists()]


    def run_timeboxed(cmd, timeout=TOOL_TIMEOUT_SECONDS):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except Exception:
            return None


    def checkout_resident(rel):
        # True when git tracks the path or anything under it: the pull request supplied it.
        # Fail closed: an inspection that cannot answer counts as checkout-supplied.
        try:
            r = subprocess.run(["git", "ls-files", "-z", "--", rel], capture_output=True, timeout=30)
            if r.returncode != 0:
                return True
            return bool(r.stdout.strip(b"\x00"))
        except Exception:
            return True


    def path_binary_trusted(binary):
        # A PATH hit is trusted only when it resolves outside the checkout. Inside it the
        # pull request may have committed the binary, so the tracking gate decides.
        try:
            resolved = pathlib.Path(binary).resolve()
            root = workspace.resolve()
        except Exception:
            return False
        try:
            rel = resolved.relative_to(root)
        except ValueError:
            return True
        return not checkout_resident(str(rel))


    if "actionlint" in enabled_tools:
        if not changed_workflow_files:
            tools_skipped.append({"tool": "actionlint", "reason": "no changed workflow files"})
        else:
            # Never execute a binary the checkout brought with it: a pull request can commit
            # an `./actionlint` or a `node_modules/.bin/*` and this runs before any sandbox.
            # Only PATH, or the checksummed release fetched here, is trusted.
            actionlint_bin = shutil.which("actionlint")
            if actionlint_bin is not None and not path_binary_trusted(actionlint_bin):
                actionlint_bin = None
            if actionlint_bin is None:
                # The release tarball against a recorded checksum, the same version
                # and checksum as tests.yml; tests/test-actionlint-pin-drift.py holds
                # the two together (#163).
                ACTIONLINT_VERSION = "1.7.12"
                ACTIONLINT_SHA256 = "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
                asset = f"actionlint_{ACTIONLINT_VERSION}_linux_amd64.tar.gz"
                install = run_timeboxed(
                    ["bash", "-c",
                     "set -euo pipefail; "
                     f"curl -fsSL --proto '=https' -o {asset} "
                     f"https://github.com/rhysd/actionlint/releases/download/v{ACTIONLINT_VERSION}/{asset}; "
                     f"echo '{ACTIONLINT_SHA256}  {asset}' | sha256sum -c -; "
                     f"tar -xzf {asset} actionlint"],
                    timeout=60,
                )
                if install is not None and install.returncode == 0 and pathlib.Path("./actionlint").exists() and not checkout_resident("actionlint"):
                    actionlint_bin = "./actionlint"
            if actionlint_bin is None:
                tools_skipped.append({"tool": "actionlint", "reason": "binary unavailable and install failed"})
            else:
                res = run_timeboxed([actionlint_bin, "-format", "{{json .}}", *changed_workflow_files])
                if res is None:
                    tools_skipped.append({"tool": "actionlint", "reason": "timed out"})
                elif res.returncode not in (0, 1):
                    tools_skipped.append({"tool": "actionlint", "reason": f"exited {res.returncode}: {res.stderr.strip()[:200]}"})
                else:
                    tools_ran.append("actionlint")
                    try:
                        errs = json.loads(res.stdout) if res.stdout.strip() else []
                    except Exception:
                        errs = []
                    for e in errs if isinstance(errs, list) else []:
                        kind = str(e.get("kind", ""))
                        tool_name = "shellcheck" if "shellcheck" in kind.lower() else "actionlint"
                        tool_findings_list.append({
                            "tool": tool_name,
                            "path": e.get("filepath", ""),
                            "line": e.get("line", 0),
                            "message": e.get("message", ""),
                        })

    if "shellcheck" in enabled_tools:
        if not changed_sh_files:
            tools_skipped.append({"tool": "shellcheck", "reason": "no changed shell files"})
        elif shutil.which("shellcheck") is None:
            tools_skipped.append({"tool": "shellcheck", "reason": "binary unavailable"})
        else:
            res = run_timeboxed(["shellcheck", "-f", "json", *changed_sh_files])
            if res is None:
                tools_skipped.append({"tool": "shellcheck", "reason": "timed out"})
            elif res.returncode not in (0, 1):
                tools_skipped.append({"tool": "shellcheck", "reason": f"exited {res.returncode}"})
            else:
                tools_ran.append("shellcheck")
                try:
                    sc_findings = json.loads(res.stdout) if res.stdout.strip() else []
                except Exception:
                    sc_findings = []
                for f in sc_findings if isinstance(sc_findings, list) else []:
                    tool_findings_list.append({
                        "tool": "shellcheck",
                        "path": f.get("file", ""),
                        "line": f.get("line", 0),
                        "message": f.get("message", ""),
                    })

    node_tools_resident = checkout_resident("node_modules")
    has_typescript = languages.get("TypeScript", 0) > 0
    if "tsc" in enabled_tools:
        if not has_typescript or "tsconfig.json" not in config_files:
            tools_skipped.append({"tool": "tsc", "reason": "no changed TypeScript files or no tsconfig.json"})
        elif node_tools_resident:
            tools_skipped.append({"tool": "tsc", "reason": "node_modules is committed in this checkout; not executing it"})
        elif not pathlib.Path("node_modules/.bin/tsc").exists():
            tools_skipped.append({"tool": "tsc", "reason": "tsc not installed in this checkout"})
        else:
            res = run_timeboxed(["node_modules/.bin/tsc", "--noEmit"])
            if res is None:
                tools_skipped.append({"tool": "tsc", "reason": "timed out"})
            else:
                tools_ran.append("tsc")
                for line in (res.stdout or "").splitlines():
                    m = re.match(r"^(.+?)\((\d+),\d+\): (.+)$", line)
                    if m:
                        tool_findings_list.append({
                            "tool": "tsc", "path": m.group(1), "line": int(m.group(2)), "message": m.group(3),
                        })

    for tool_name, bin_path in (("eslint", "node_modules/.bin/eslint"), ("biome", "node_modules/.bin/biome")):
        if tool_name not in enabled_tools:
            continue
        applies = "biome.json" in config_files if tool_name == "biome" else any(c.startswith(".eslintrc") for c in config_files)
        if not applies:
            tools_skipped.append({"tool": tool_name, "reason": "no config file present"})
            continue
        if node_tools_resident:
            tools_skipped.append({"tool": tool_name, "reason": "node_modules is committed in this checkout; not executing it"})
            continue
        if not pathlib.Path(bin_path).exists():
            tools_skipped.append({"tool": tool_name, "reason": f"{tool_name} not installed in this checkout"})
            continue
        targets = [p for p in changed_paths if pathlib.Path(p).exists() and classify_language(p) in ("TypeScript", "JavaScript")]
        if not targets:
            tools_skipped.append({"tool": tool_name, "reason": "no changed JS/TS files"})
            continue
        cmd = [bin_path, "--format", "json", *targets] if tool_name == "eslint" else [bin_path, "check", "--reporter", "json", *targets]
        res = run_timeboxed(cmd)
        if res is None:
            tools_skipped.append({"tool": tool_name, "reason": "timed out"})
            continue
        tools_ran.append(tool_name)
        # Best-effort: a linter's JSON shape is not re-derived beyond what's common to
        # both, so an unrecognised shape yields zero findings rather than a crash.
        try:
            if tool_name == "eslint":
                parsed = json.loads(res.stdout) if res.stdout.strip() else []
                if isinstance(parsed, list):
                    for file_result in parsed:
                        for msg in file_result.get("messages", []):
                            tool_findings_list.append({
                                "tool": "eslint",
                                "path": file_result.get("filePath", ""),
                                "line": msg.get("line", 0),
                                "message": msg.get("message", ""),
                            })
        except Exception:
            pass

    if tools_skipped:
        failed_names = sorted({
            s["tool"] for s in tools_skipped
            if "no changed" not in s["reason"] and "no config" not in s["reason"]
        })
        if failed_names:
            notes.append(f"tool(s) failed to run: {', '.join(failed_names)}")

    tool_findings_context = {"ran": tools_ran, "skipped": tools_skipped, "findings": tool_findings_list}

    # `resolve` is the single owner of the base PR lookup, recovery included
    # (CR #173, thread 4000816174): this step reads its final result rather
    # than repeating the lookup, so telemetry (which also reads resolve's
    # output directly) can never disagree with what the manifest carries.
    base_pull_request = None
    base_pr_num = os.environ.get("BASE_PR_NUMBER", "").strip()
    base_pr_title = os.environ.get("BASE_PR_TITLE", "").strip()
    if base_pr_num:
        try:
            base_pull_request = {"number": int(base_pr_num), "title": base_pr_title}
        except Exception:
            base_pull_request = None

    # Kept entries from .claude-context.json, or [] (#90).
    cross_repo_context = []
    claude_context_file = workspace / ".claude-context.json"
    if claude_context_file.is_file():
        try:
            cross_repo_context = json.loads(claude_context_file.read_text(encoding="utf-8"))
            if not isinstance(cross_repo_context, list):
                cross_repo_context = []
        except Exception:
            cross_repo_context = []

    # ---------------------------------------------------------------------------
    manifest["context"] = {
        "profile": profile,
        "issues": issues_context,
        "ci_failures": ci_context,
        "dependencies": dependencies_context,
        "tool_findings": tool_findings_context,
        "base_pull_request": base_pull_request,
        "cross_repo": cross_repo_context,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    context_notes = "; ".join(notes)
    print(
        f"review context: {len(resolved_issues)} issue(s) resolved, {len(unresolved_issues)} unresolved, "
        f"ci={ci_context['state']}, dependencies={'yes' if lockfile_path else 'no'}, tools ran={tools_ran}"
    )
    if context_notes:
        print(f"review context notes: {context_notes}")

    github_output = os.environ.get("GITHUB_OUTPUT", "")
    if github_output:
        # Single line: this reaches the liveness comment verbatim.
        safe_notes = context_notes.replace("\n", " ").replace("\r", " ")
        with open(github_output, "a", encoding="utf-8") as f:
            f.write(f"context_notes={safe_notes}\n")


def main():
    with _github_output_to_stderr("Build review manifest"):
        build_review_manifest()
    with _github_output_to_stderr("Build review context"):
        build_review_context()


if __name__ == "__main__":
    main()
