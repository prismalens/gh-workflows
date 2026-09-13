#!/usr/bin/env python3
"""Guards the actionlint pin and installer against silent drift (#163).

Run: python3 tests/test-actionlint-pin-drift.py
"""
import pathlib
import re
import sys
import tempfile
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
TESTS_WF = ROOT / ".github/workflows/tests.yml"
REVIEW_WF = ROOT / ".github/workflows/claude-code-review.yml"
WORKFLOWS_DIR = ROOT / ".github/workflows"

# Matched with regexes from review job's run block (#163).
REVIEW_VERSION_RE = re.compile(r'ACTIONLINT_VERSION = "([^"]+)"')
REVIEW_SHA_RE = re.compile(r'ACTIONLINT_SHA256 = "([0-9a-f]{64})"')
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def check_actionlint_pins(tests_path: pathlib.Path, review_path: pathlib.Path, workflows_dir: pathlib.Path = None):
    """Pure checker validating pin equality, checksum format, secure flags, and forbidden URLs (#163)."""
    if not tests_path.exists():
        return False, f"{tests_path}: file not found"
    if not review_path.exists():
        return False, f"{review_path}: file not found"

    tests_text = tests_path.read_text(encoding="utf-8")
    tests_yaml = yaml.safe_load(tests_text)
    test_steps = tests_yaml.get("jobs", {}).get("test", {}).get("steps", [])

    actionlint_step = None
    say_when_step = None
    for step in test_steps:
        name = step.get("name")
        if name == "actionlint":
            actionlint_step = step
        elif name == "Say when the actionlint pin is behind the latest release":
            say_when_step = step

    if not actionlint_step:
        return False, f"{tests_path}: missing step 'actionlint'"
    if not say_when_step:
        return False, f"{tests_path}: missing step 'Say when the actionlint pin is behind the latest release'"

    tests_v1 = str(actionlint_step.get("env", {}).get("ACTIONLINT_VERSION", ""))
    tests_v2 = str(say_when_step.get("env", {}).get("ACTIONLINT_VERSION", ""))
    tests_sha = str(actionlint_step.get("env", {}).get("ACTIONLINT_SHA256", ""))
    actionlint_body = str(actionlint_step.get("run", ""))

    review_text = review_path.read_text(encoding="utf-8")
    v_match = REVIEW_VERSION_RE.search(review_text)
    if not v_match:
        return False, f"{review_path}: ACTIONLINT_VERSION regex did not match"
    review_v = v_match.group(1)

    s_match = REVIEW_SHA_RE.search(review_text)
    if not s_match:
        return False, f"{review_path}: ACTIONLINT_SHA256 regex did not match"
    review_sha = s_match.group(1)

    if not (tests_v1 == tests_v2 == review_v):
        return False, (
            f"actionlint versions disagree: {tests_path} actionlint={tests_v1!r}, "
            f"{tests_path} say-when={tests_v2!r}, {review_path}={review_v!r}"
        )

    if not HEX64_RE.fullmatch(tests_sha):
        return False, f"{tests_path}: checksum is not 64 lowercase hex, got {tests_sha!r}"
    if not HEX64_RE.fullmatch(review_sha):
        return False, f"{review_path}: checksum is not 64 lowercase hex, got {review_sha!r}"

    if tests_sha != review_sha:
        return False, (
            f"actionlint checksums disagree: {tests_path}={tests_sha!r} != {review_path}={review_sha!r}"
        )

    if "sha256sum -c" not in actionlint_body:
        return False, f"{tests_path}: actionlint step body missing 'sha256sum -c'"
    if "--proto '=https'" not in actionlint_body:
        return False, f"{tests_path}: actionlint step body missing \"--proto '=https'\""

    # Upstream shell script and raw usercontent URLs are forbidden (#163).
    if workflows_dir and workflows_dir.exists():
        for fpath in sorted(workflows_dir.glob("*.yml")):
            content = fpath.read_text(encoding="utf-8")
            if "download-actionlint.bash" in content:
                return False, f"{fpath}: contains forbidden 'download-actionlint.bash' (#163)"
            if "raw.githubusercontent.com/rhysd" in content:
                return False, f"{fpath}: contains forbidden 'raw.githubusercontent.com/rhysd' (#163)"

    return True, "all actionlint pin checks passed"


def main():
    fails = []
    print("=== Testing actionlint Pin and Checksum Drift (#163) ===\n")

    # Case 1: Real workflow files
    ok, msg = check_actionlint_pins(TESTS_WF, REVIEW_WF, WORKFLOWS_DIR)
    if not ok:
        fails.append(f"real workflow files: {msg}")
        print(f"  FAIL  real workflow files: {msg}")
    else:
        print(f"  ok    real workflow files: {msg}")

    with tempfile.TemporaryDirectory() as td:
        tdp = pathlib.Path(td)
        base_tests = tdp / "tests.yml"
        base_review = tdp / "claude-code-review.yml"
        mock_wf_dir = tdp / "workflows"
        mock_wf_dir.mkdir()

        base_tests.write_text(TESTS_WF.read_text(encoding="utf-8"), encoding="utf-8")
        base_review.write_text(REVIEW_WF.read_text(encoding="utf-8"), encoding="utf-8")

        # Fixtures mutate the live pin, so a pin bump never breaks them (#163).
        review_text = REVIEW_WF.read_text(encoding="utf-8")
        pin_v = REVIEW_VERSION_RE.search(review_text).group(1)
        pin_sha = REVIEW_SHA_RE.search(review_text).group(1)
        tests_pin_line = f"ACTIONLINT_VERSION: {pin_v}"
        if base_tests.read_text(encoding="utf-8").count(tests_pin_line) != 2:
            fails.append(f"{TESTS_WF}: want 2 lines {tests_pin_line!r}, fixtures cannot be built")

        # Case 2: Negative fixture - tests.yml actionlint step version disagreeing
        bad_tests_v1 = tdp / "tests-bad-v1.yml"
        bad_tests_v1.write_text(
            base_tests.read_text(encoding="utf-8").replace(tests_pin_line, "ACTIONLINT_VERSION: 1.7.99", 1),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(bad_tests_v1, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture tests.yml actionlint version drift passed unexpectedly")
            print("  FAIL  negative fixture: tests.yml actionlint version drift not caught")
        elif "tests-bad-v1.yml" not in msg or "1.7.99" not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: tests.yml actionlint version caught ({msg})")

        # Case 3: Negative fixture - tests.yml say-when step version disagreeing
        bad_tests_v2 = tdp / "tests-bad-v2.yml"
        raw_text = base_tests.read_text(encoding="utf-8")
        parts = raw_text.split(tests_pin_line)
        if len(parts) >= 3:
            bad_v2_text = parts[0] + tests_pin_line + parts[1] + "ACTIONLINT_VERSION: 1.7.98" + tests_pin_line.join(parts[2:])
            bad_tests_v2.write_text(bad_v2_text, encoding="utf-8")
            ok, msg = check_actionlint_pins(bad_tests_v2, base_review, mock_wf_dir)
            if ok:
                fails.append("negative fixture tests.yml say-when version drift passed unexpectedly")
                print("  FAIL  negative fixture: tests.yml say-when version drift not caught")
            elif "tests-bad-v2.yml" not in msg or "1.7.98" not in msg:
                fails.append(f"negative fixture message missing file or value: {msg}")
                print(f"  FAIL  negative fixture: message missing details: {msg}")
            else:
                print(f"  ok    negative fixture: tests.yml say-when version caught ({msg})")

        # Case 4: Negative fixture - claude-code-review.yml version disagreeing
        bad_review_v = tdp / "review-bad-v.yml"
        bad_review_v.write_text(
            base_review.read_text(encoding="utf-8").replace(f'ACTIONLINT_VERSION = "{pin_v}"', 'ACTIONLINT_VERSION = "1.7.97"'),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(base_tests, bad_review_v, mock_wf_dir)
        if ok:
            fails.append("negative fixture review version drift passed unexpectedly")
            print("  FAIL  negative fixture: review version drift not caught")
        elif "review-bad-v.yml" not in msg or "1.7.97" not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: review version drift caught ({msg})")

        # Case 5: Negative fixture - tests.yml checksum disagreeing
        bad_tests_sha = tdp / "tests-bad-sha.yml"
        drifted_sha = pin_sha[:-1] + ("0" if pin_sha[-1] != "0" else "1")
        bad_tests_sha.write_text(
            base_tests.read_text(encoding="utf-8").replace(
                pin_sha,
                drifted_sha,
            ),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(bad_tests_sha, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture tests.yml checksum drift passed unexpectedly")
            print("  FAIL  negative fixture: tests.yml checksum drift not caught")
        elif "tests-bad-sha.yml" not in msg or drifted_sha not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: tests.yml checksum drift caught ({msg})")

        # Case 6: Negative fixture - claude-code-review.yml checksum disagreeing
        bad_review_sha = tdp / "review-bad-sha.yml"
        bad_review_sha.write_text(
            base_review.read_text(encoding="utf-8").replace(
                pin_sha,
                drifted_sha,
            ),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(base_tests, bad_review_sha, mock_wf_dir)
        if ok:
            fails.append("negative fixture review checksum drift passed unexpectedly")
            print("  FAIL  negative fixture: review checksum drift not caught")
        elif "review-bad-sha.yml" not in msg or drifted_sha not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: review checksum drift caught ({msg})")

        # Case 7: Negative fixture - non-64-lowercase-hex checksum in tests.yml
        bad_hex_file = tdp / "tests-bad-hex.yml"
        invalid_hex = "Z" + pin_sha[1:]
        bad_hex_file.write_text(
            base_tests.read_text(encoding="utf-8").replace(
                pin_sha,
                invalid_hex,
            ),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(bad_hex_file, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture invalid checksum hex passed unexpectedly")
            print("  FAIL  negative fixture: invalid checksum hex not caught")
        elif "tests-bad-hex.yml" not in msg or invalid_hex not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: invalid checksum hex caught ({msg})")

        # Case 7b: Negative fixture - review file missing valid 64-hex regex match
        bad_rev_hex = tdp / "review-bad-hex.yml"
        bad_rev_hex.write_text(
            base_review.read_text(encoding="utf-8").replace(
                pin_sha,
                invalid_hex,
            ),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(base_tests, bad_rev_hex, mock_wf_dir)
        if ok:
            fails.append("negative fixture review invalid checksum passed unexpectedly")
            print("  FAIL  negative fixture: review invalid checksum not caught")
        elif "review-bad-hex.yml" not in msg:
            fails.append(f"negative fixture message missing file: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: review invalid checksum caught ({msg})")

        # Case 8: Negative fixture - missing sha256sum -c in actionlint step
        bad_body = tdp / "tests-no-sha-check.yml"
        bad_body.write_text(
            base_tests.read_text(encoding="utf-8").replace("sha256sum -c", "echo ok"),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(bad_body, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture missing sha256sum passed unexpectedly")
            print("  FAIL  negative fixture: missing sha256sum not caught")
        elif "tests-no-sha-check.yml" not in msg or "sha256sum -c" not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: missing sha256sum caught ({msg})")

        # Case 9: Negative fixture - missing --proto '=https' in actionlint step
        bad_proto = tdp / "tests-no-proto.yml"
        bad_proto.write_text(
            base_tests.read_text(encoding="utf-8").replace("--proto '=https'", ""),
            encoding="utf-8",
        )
        ok, msg = check_actionlint_pins(bad_proto, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture missing --proto passed unexpectedly")
            print("  FAIL  negative fixture: missing --proto not caught")
        elif "tests-no-proto.yml" not in msg or "--proto '=https'" not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: missing --proto caught ({msg})")

        # Case 10: Negative fixture - forbidden download-actionlint.bash
        forbidden_wf = mock_wf_dir / "forbidden-script.yml"
        forbidden_wf.write_text("run: curl -s https://example.com/download-actionlint.bash | bash\n", encoding="utf-8")
        ok, msg = check_actionlint_pins(base_tests, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture forbidden download-actionlint.bash passed unexpectedly")
            print("  FAIL  negative fixture: forbidden download-actionlint.bash not caught")
        elif "forbidden-script.yml" not in msg or "download-actionlint.bash" not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: forbidden download-actionlint.bash caught ({msg})")
        forbidden_wf.unlink()

        # Case 11: Negative fixture - forbidden raw.githubusercontent.com/rhysd
        forbidden_url = mock_wf_dir / "forbidden-url.yml"
        forbidden_url.write_text("run: curl https://raw.githubusercontent.com/rhysd/actionlint/main/install.bash\n", encoding="utf-8")
        ok, msg = check_actionlint_pins(base_tests, base_review, mock_wf_dir)
        if ok:
            fails.append("negative fixture forbidden raw.githubusercontent.com/rhysd passed unexpectedly")
            print("  FAIL  negative fixture: forbidden raw.githubusercontent.com/rhysd not caught")
        elif "forbidden-url.yml" not in msg or "raw.githubusercontent.com/rhysd" not in msg:
            fails.append(f"negative fixture message missing file or value: {msg}")
            print(f"  FAIL  negative fixture: message missing details: {msg}")
        else:
            print(f"  ok    negative fixture: forbidden raw.githubusercontent.com/rhysd caught ({msg})")
        forbidden_url.unlink()

    print()
    if fails:
        print(f"{len(fails)} FAILED:")
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)

    print("all actionlint pin drift checks passed")


if __name__ == "__main__":
    main()
