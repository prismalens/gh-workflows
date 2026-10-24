# ACP recording format

One file format for a recorded Agent Client Protocol session. PrismaLens's and Assayer's
recorders write it, and their tests replay it. Story: #250.

A recording is made on the operator's machine against a real model, when a pin moves
(`pin-bump`'s checkbox). CI never makes one; CI replays them or runs the engine against
aimock fixtures (`actions/setup-acp-engine`).

## File

JSON Lines, UTF-8, one object per line, named `*.acp.jsonl`.

### Line 1: header

```json
{"acp_recording": 1, "agent": {"name": "claude-code", "version": "2.1.310"}, "adapter": {"name": "@agentclientprotocol/claude-agent-acp", "version": "0.95.0"}, "model": "claude-opus-5-5", "recorded_at": "2026-10-24T10:00:00.000Z", "recorder": {"name": "assayer", "version": "0.0.2"}}
```

| Field | Required | Meaning |
| :-- | :-: | :-- |
| `acp_recording` | yes | Schema version, an integer. This document is version 1. A reader refuses a version it does not know. |
| `agent.name`, `agent.version` | yes | The engine as it reports itself. |
| `adapter.name`, `adapter.version` | yes | The ACP adapter, or the engine again when it speaks ACP itself (`opencode acp`). |
| `model` | yes | The model id the session used. |
| `recorded_at` | yes | ISO 8601 time the session started. |
| `recorder` | yes | The product and version that wrote the file. |

Extra header fields are allowed and ignored by readers.

### Every other line: one frame

```json
{"dir": "out", "at": "2026-10-24T10:00:00.120Z", "frame": {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}}}
{"dir": "in", "at": "2026-10-24T10:00:00.480Z", "frame": {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1}}}
{"dir": "in", "at": "2026-10-24T10:00:03.010Z", "frame": {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1", "update": {"sessionUpdate": "agent_message_chunk"}}}}
```

| Field | Meaning |
| :-- | :-- |
| `dir` | `"out"`: the client sent it to the agent. `"in"`: the agent sent it to the client. |
| `at` | ISO 8601 time with milliseconds, when the recorder saw the frame. |
| `frame` | The JSON-RPC message exactly as it crossed stdio, after redaction: requests, responses, notifications and errors, in both directions, including agent-to-client requests such as `session/request_permission` and `fs/read_text_file` and the client's answers. |

Frames appear in the order the recorder saw them. Nothing is summarised or dropped. A
reader that only wants session updates filters `method == "session/update"`.

## Redaction

Done at record time, before the line is written, so no secret ever reaches disk:

- Values of environment variables and fields whose name matches
  `/(token|secret|key|password|authorization|cookie)/i` become `"<redacted>"`.
- Anything shaped like a known credential (`gh[pousr]_…`, `github_pat_…`, `sk-…`,
  `xox[abp]-…`, a JWT) becomes `"<redacted>"` wherever it appears in a string.
- The user's home directory becomes `~`, and the session's working directory becomes
  `/checkout`, in every string.

A recording that still matches the credential shapes above fails the recorder's own check
and is not written.

## Replay

A recording replays in two ways, and the format serves both:

1. **Client-side**: feed the `in` frames to the product's ACP client or mapper and assert
   on what it produces. Assayer's `runner/test/replay.test.js` does this today.
2. **Into a real engine**: start the pinned engine and adapter against aimock, send the
   `out` frames in order, and compare the `in` frames by method and shape. The model turns
   come from aimock fixtures made from the same session. Ids, timestamps and session ids
   are compared by position, not value.

## Relation to Assayer's `raw.jsonl`

Assayer's `runner/fixtures/<name>/raw.jsonl` holds decoded rows (`kind: initialize |
session | update | stop`). Each one comes from a frame here:

| `raw.jsonl` `kind` | Frame |
| :-- | :-- |
| `initialize` | `in` response to `initialize` |
| `session` | `in` response to `session/new` (its `sessionId`) |
| `update` | `in` `session/update` notification (`notification` = `params`) |
| `stop` | `in` response to `session/prompt` (`response` = `result`) |

So version 1 is a superset of it, and a converter is a filter.
