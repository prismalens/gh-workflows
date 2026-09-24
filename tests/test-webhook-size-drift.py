#!/usr/bin/env python3
"""The webhook counts reviewable lines exactly as the review lane does (#184).

`worker/review-size.js` ports the arithmetic of the lane's "Build review manifest" step so
the App webhook can refuse an oversized pull request without a checkout. This runs the
lane's REAL step (through tests/test-review-manifest.py's harness) and the Worker's port
on the same `pulls/{n}/files` fixtures and fails on any disagreement, so the two cannot
drift apart silently.

Run: python3 tests/test-webhook-size-drift.py
"""
import importlib.util
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SIZE_JS = ROOT / "worker/review-size.js"

spec = importlib.util.spec_from_file_location("review_manifest", ROOT / "tests/test-review-manifest.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def f(filename, additions, deletions=0, **over):
    item = {"filename": filename, "status": "modified", "additions": additions, "deletions": deletions, "patch": "@@"}
    item.update(over)
    return {k: v for k, v in item.items() if v is not None}


FIXTURES = {
    "plain modified and added": [f("src/a.js", 10, 5), f("src/b.js", 7, status="added")],
    "default path filters": [
        f("package-lock.json", 900), f("go.sum", 50), f("dist/app.js", 40), f("build", 3),
        f("vendor/x/y.go", 20), f("pkg/__snapshots__/a.snap", 9), f("web/app.min.js", 8),
        f("web/app.min.css", 8), f("a/node_modules/b.js", 5), f("node_modules/root.js", 6),
    ],
    "statuses": [
        f("gone.js", 0, 40, status="removed"),
        f("moved.js", 0, 0, status="renamed", patch=None, previous_filename="old.js"),
        f("moved2.js", 3, 1, status="renamed", previous_filename="old2.js"),
        f("copied.js", 4, status="copied"),
        f("changed.js", 2, status="changed"),
        f("weird.js", 1, status="something-new"),
    ],
    "binary and truncated patch": [f("logo.png", 300, patch=None), f("huge.txt", 12, patch=None)],
    "per-file cap": [f("big.js", 2001), f("edge.js", 2000), f("small.js", 1)],
}


def worker_count(files):
    code = (
        f"import {{ reviewableLinesFromFiles }} from {json.dumps(SIZE_JS.as_uri())};\n"
        "let raw = ''; process.stdin.on('data', (c) => (raw += c));\n"
        "process.stdin.on('end', () => console.log(reviewableLinesFromFiles(JSON.parse(raw))));\n"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", code], input=json.dumps(files),
                       capture_output=True, text=True, check=True)
    return int(p.stdout.strip())


def lane_count(script, files):
    rc, outputs, _manifest, _diff, stdout, stderr = harness.run_manifest_step(script, gh_files_json=files)
    if rc != 0 or "reviewable_lines" not in outputs:
        raise RuntimeError(f"lane step failed rc={rc}: {stderr[-400:]}")
    return int(outputs["reviewable_lines"])


def main() -> int:
    script = harness.extract_step_script()
    fails = []
    for name, files in FIXTURES.items():
        lane = lane_count(script, files)
        worker = worker_count(files)
        ok = lane == worker
        print(f"  {'ok  ' if ok else 'FAIL'}  {name}: lane {lane}, worker {worker}")
        if not ok:
            fails.append(name)
    if fails:
        print(f"\n{len(fails)} FAILED: the webhook's count has drifted from the lane's")
        return 1
    print("\nall webhook size drift checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
