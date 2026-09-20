Captured 2026-09-19 from `opencode acp` 1.18.30 on `opencode/mimo-v2.5-free`, a three-step
smoke prompt (read one file, one inline comment, one summary) over a sreforge checkout, with
the checkout path replaced by `/checkout`. `raw.jsonl` is every ACP message the runner saw;
`tool-log.jsonl` is what the comment MCP servers recorded. `test/replay.test.js` feeds both
back through the mapper.
