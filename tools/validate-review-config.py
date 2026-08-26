#!/usr/bin/env python3
"""Validates .github/claude-review.yml against the S0 configuration schema.

Enforces strict day-one validation:
- Rejects unknown top-level or nested keys with hard exit 1
- Validates types and allowed values per schema
- Exits 0 on valid config, 1 on any violation
"""
import pathlib
import sys
import yaml


ALLOWED_TOP_LEVEL_KEYS = {"version", "review", "findings"}

ALLOWED_REVIEW_KEYS = {
    "default_model",
    "auto_pause_rounds",
    "skip_authors",
    "path_filters",
    "path_instructions",
}

ALLOWED_PATH_INSTRUCTION_KEYS = {"path", "instructions"}

ALLOWED_FINDINGS_KEYS = {
    "suppress_below",
    "enable_ai_fix_prompt",
    "include_verification_note",
}

ALLOWED_DEFAULT_MODELS = {"claude-sonnet-5", "claude-opus-5"}
ALLOWED_SUPPRESS_BELOW = {"none", "Minor", "Major", "Critical"}


def validate_config(content: str, filename: str = ".github/claude-review.yml") -> list[str]:
    errors = []
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        return [f"Malformed YAML in {filename}: {exc}"]

    # Empty file or comments only is valid (applied built-in defaults)
    if data is None:
        return []

    if not isinstance(data, dict):
        return [f"Invalid YAML structure in {filename}: expected a mapping/dictionary, got {type(data).__name__}"]

    # Check for unknown top-level keys
    for key in data:
        if key not in ALLOWED_TOP_LEVEL_KEYS:
            errors.append(f"Unknown configuration key '{key}' in {filename}")

    if errors:
        return errors

    # Check version
    if "version" not in data:
        errors.append(f"Missing required key 'version' in {filename}")
    else:
        version = data["version"]
        if isinstance(version, bool) or not isinstance(version, int) or version != 1:
            errors.append(f"Invalid value for 'version' in {filename}: expected integer 1, got {version!r}")

    # Check review object
    if "review" in data:
        review = data["review"]
        if not isinstance(review, dict):
            errors.append(f"Invalid value for 'review' in {filename}: expected mapping, got {type(review).__name__}")
        else:
            for key in review:
                if key not in ALLOWED_REVIEW_KEYS:
                    errors.append(f"Unknown configuration key 'review.{key}' in {filename}")

            if "default_model" in review:
                model = review["default_model"]
                if not isinstance(model, str) or model not in ALLOWED_DEFAULT_MODELS:
                    errors.append(
                        f"Invalid value for 'review.default_model' in {filename}: {model!r}. "
                        f"Allowed values: {sorted(ALLOWED_DEFAULT_MODELS)}"
                    )

            if "auto_pause_rounds" in review:
                rounds = review["auto_pause_rounds"]
                if isinstance(rounds, bool) or not isinstance(rounds, int) or rounds < 1:
                    errors.append(
                        f"Invalid value for 'review.auto_pause_rounds' in {filename}: {rounds!r}. "
                        f"Must be an integer >= 1"
                    )

            if "skip_authors" in review:
                skip = review["skip_authors"]
                if not isinstance(skip, list) or not all(isinstance(x, str) for x in skip):
                    errors.append(f"Invalid value for 'review.skip_authors' in {filename}: expected list of strings")

            if "path_filters" in review:
                filters = review["path_filters"]
                if not isinstance(filters, list) or not all(isinstance(x, str) for x in filters):
                    errors.append(f"Invalid value for 'review.path_filters' in {filename}: expected list of strings")

            if "path_instructions" in review:
                instructions = review["path_instructions"]
                if not isinstance(instructions, list):
                    errors.append(
                        f"Invalid value for 'review.path_instructions' in {filename}: expected list of mappings"
                    )
                else:
                    for i, item in enumerate(instructions):
                        if not isinstance(item, dict):
                            errors.append(
                                f"Invalid value for 'review.path_instructions[{i}]' in {filename}: expected mapping"
                            )
                            continue
                        for k in item:
                            if k not in ALLOWED_PATH_INSTRUCTION_KEYS:
                                errors.append(
                                    f"Unknown configuration key 'review.path_instructions[{i}].{k}' in {filename}"
                                )
                        if "path" not in item or not isinstance(item["path"], str):
                            errors.append(
                                f"Missing or invalid required key 'path' in 'review.path_instructions[{i}]' in {filename}"
                            )
                        if "instructions" not in item or not isinstance(item["instructions"], str):
                            errors.append(
                                f"Missing or invalid required key 'instructions' in 'review.path_instructions[{i}]' in {filename}"
                            )

    # Check findings object
    if "findings" in data:
        findings = data["findings"]
        if not isinstance(findings, dict):
            errors.append(f"Invalid value for 'findings' in {filename}: expected mapping, got {type(findings).__name__}")
        else:
            for key in findings:
                if key not in ALLOWED_FINDINGS_KEYS:
                    errors.append(f"Unknown configuration key 'findings.{key}' in {filename}")

            if "suppress_below" in findings:
                sb = findings["suppress_below"]
                if not isinstance(sb, str) or sb not in ALLOWED_SUPPRESS_BELOW:
                    errors.append(
                        f"Invalid value for 'findings.suppress_below' in {filename}: {sb!r}. "
                        f"Allowed values: {sorted(ALLOWED_SUPPRESS_BELOW)}"
                    )

            if "enable_ai_fix_prompt" in findings:
                eafp = findings["enable_ai_fix_prompt"]
                if not isinstance(eafp, bool):
                    errors.append(f"Invalid value for 'findings.enable_ai_fix_prompt' in {filename}: expected boolean")

            if "include_verification_note" in findings:
                ivn = findings["include_verification_note"]
                if not isinstance(ivn, bool):
                    errors.append(f"Invalid value for 'findings.include_verification_note' in {filename}: expected boolean")

    return errors


def main() -> int:
    if len(sys.argv) > 1:
        target = pathlib.Path(sys.argv[1])
    else:
        target = pathlib.Path(".github/claude-review.yml")

    if not target.exists():
        print(f"File not found: {target}", file=sys.stderr)
        return 1

    try:
        content = target.read_text(encoding="utf-8")
    except Exception as exc:
        print(f"Error reading {target}: {exc}", file=sys.stderr)
        return 1

    errors = validate_config(content, str(target))
    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1

    print(f"OK: {target} is valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
