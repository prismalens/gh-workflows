#!/usr/bin/env python3
"""Golden fixture test for prompt extraction in claude-fix.yml.

Verifies that the extraction regex in claude-fix.yml matches conforming review
comment bodies (golden fixtures) and extracts the executable prompt instruction
containing the standing preamble and file-anchored instruction.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "tests/fixtures/golden-finding-envelope.md"

# Extraction pattern defined in S3 Section 4.4 / 8.2
EXTRACTION_PATTERN = re.compile(
    r"<details>\s*<summary>\s*.*?Prompt for AI Agents\s*</summary>\s*```(?:text)?\s*(.*?)\s*```\s*</details>",
    re.DOTALL | re.IGNORECASE,
)

STANDING_PREAMBLE = (
    "Verify each finding against current code. Fix only still-valid issues, skip the\n"
    "rest with a brief reason, keep changes minimal, and validate."
)


def extract_prompt(comment_body: str) -> str | None:
    match = EXTRACTION_PATTERN.search(comment_body)
    if match:
        return match.group(1).strip()
    return None


def test_golden_fixture():
    assert FIXTURE_PATH.exists(), f"Missing golden fixture: {FIXTURE_PATH}"
    body = FIXTURE_PATH.read_text(encoding="utf-8")
    extracted = extract_prompt(body)
    assert extracted is not None, "Extraction failed on golden-finding-envelope.md"
    assert extracted.startswith(STANDING_PREAMBLE), (
        f"Extracted prompt did not start with standing preamble. Got:\n{extracted}"
    )
    assert "In `packages/core/src/auth.ts` around lines 45-52:" in extracted, (
        f"Extracted prompt missing target anchor. Got:\n{extracted}"
    )
    return True


def test_variations_and_fallbacks():
    # Variation 1: with explicit 'text' codeblock tag and different whitespace
    v1 = """
    _🔒 Security & Privacy_ | _🔴 Critical_ | _⚡ Quick win_

    <details> <summary> 🤖 Prompt for AI Agents </summary>
    ```text
    Verify each finding against current code. Fix only still-valid issues, skip the
    rest with a brief reason, keep changes minimal, and validate.

    In `src/api.ts` at line 100: Sanitize input parameter.
    ```
    </details>
    """
    ext1 = extract_prompt(v1)
    assert ext1 is not None, "Failed to extract with text codeblock tag"
    assert "In `src/api.ts` at line 100: Sanitize input parameter." in ext1

    # Variation 2: no emoji in summary tag (ASCII anchor match)
    v2 = """
    <details>
    <summary>Prompt for AI Agents</summary>
    ```
    Verify each finding against current code. Fix only still-valid issues, skip the
    rest with a brief reason, keep changes minimal, and validate.

    In `config.json` at line 5: Fix typo.
    ```
    </details>
    """
    ext2 = extract_prompt(v2)
    assert ext2 is not None, "Failed to extract without emoji in summary"
    assert "In `config.json` at line 5: Fix typo." in ext2

    # Negative case: prose comment without details block (returns None, triggers fallback)
    neg1 = "This is a regular comment without any structured envelope."
    assert extract_prompt(neg1) is None, "Expected None for plain comment"

    # Negative case: details block for verification note only
    neg2 = """
    <details>
    <summary>🔍 Verification note</summary>
    > **Validation:** Checked something.
    </details>
    """
    assert extract_prompt(neg2) is None, "Expected None when only verification note is present"

    return True


def main() -> int:
    print(f"Testing fix prompt extraction against {FIXTURE_PATH.name} and variations...\n")
    try:
        test_golden_fixture()
        print("  ok    golden-finding-envelope.md extraction")
        test_variations_and_fallbacks()
        print("  ok    whitespace, tag variations, and fallback negative cases")
        print("\nAll prompt extraction tests passed.")
        return 0
    except AssertionError as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
