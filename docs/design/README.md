# Design artboards

These artboards were a starting aid, not the plan of record. The dashboard code is the source of
truth. An artboard is deleted in the pull request that builds, refuses or replaces its screen; git
history is the archive for anything removed this way. See #141.

| Artboard | Screen | Retires with |
| --- | --- | --- |
| `canvas/FindingsInbox.dc.html` | Findings inbox | #111 |
| `canvas/Config.dc.html` | Configuration | #78 |
| `canvas/Keys.dc.html` | Credential registry | #77 |
| `canvas/Agents.dc.html` | Agent registry | #81 |
| `canvas/Onboarding.dc.html` | First-run setup | #79 |
| `canvas/RepoChecklist.dc.html` | Per-repository setup checklist | #79 or #80 |

The five parked artboards predate the self-host ruling of 2026-08-31 and show tenancy and billing
modes that ruling removed; read them as sketches.

The three original design canvases of 2026-08-31 remain published at these URLs, kept as the trail,
not as current designs:
- Lane A, merged: https://claude.ai/code/artifact/470c094f-0d7f-4195-9af1-58db3e336e85
- Lane B, review product: https://claude.ai/code/artifact/f9c9927c-c4c1-4dfa-a10b-7682ab2e4078
- Lane C, control plane: https://claude.ai/code/artifact/0d8f0498-d929-4852-b34b-cc68b2a16805

## Research

- `research/review-dashboard-prior-art.md` — six AI review products and four LLM observability tools, what each shows and what to copy or reject.
- `research/review-dashboard-options.md` — storage and hosting comparison.
- `research/review-lane-cost-baseline.md` — the measured baseline.
- `research/review-cost-spec-2026-08-21.md` — the review cost spec of 2026-08-21, including the open warning that incremental review may raise fix-round cost.
