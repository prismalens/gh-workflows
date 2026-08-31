# Design Canvases

These are the design artboards for the review dashboard. They are static HTML; open one in a browser to view it.

Lane A is the merged, current design. Lanes B and C are dated records of two earlier independent designs kept for the trail back to why a decision was made, and are not current.

| Artboard | Screen |
| --- | --- |
| `canvas/Main.dc.html` | The overview, steady state |
| `canvas/OverviewEmpty.dc.html` | The overview with no rounds in range |
| `canvas/OverviewSparse.dc.html` | The overview below the sparse-range threshold, rendering the round table instead of tiles |
| `canvas/OverviewScale.dc.html` | The overview at higher round volume |
| `canvas/Rounds.dc.html` | The rounds table |
| `canvas/RoundDetail.dc.html` | A single round, six panels |
| `canvas/Repos.dc.html` | Repositories that have posted |
| `canvas/NoAccess.dc.html` | The unauthenticated state |
| `canvas/Failures.dc.html` | The failure surface page |
| `canvas/Compare.dc.html` | Named-changes comparison |
| `canvas/Config.dc.html` | Configuration |
| `canvas/Keys.dc.html` | Credential registry |
| `canvas/Agents.dc.html` | Agent registry |
| `canvas/PRIndex.dc.html` | Pull request index |
| `canvas/PRDetail.dc.html` | Pull request detail |
| `canvas/FindingsInbox.dc.html` | Findings inbox |
| `canvas/Onboarding.dc.html` | First-run setup |
| `canvas/RepoChecklist.dc.html` | Per-repository setup checklist |
| `canvas/review-lane-operator-console-stacked.html` | All lane A artboards on one page |

Not every screen in the table is built yet, and the issues in the `Assayer` milestone carry the build order.

## Research

- `research/review-dashboard-prior-art.md` — six AI review products and four LLM observability tools, what each shows and what to copy or reject.
- `research/review-dashboard-options.md` — storage and hosting comparison.
- `research/review-lane-cost-baseline.md` — the measured baseline.
- `research/review-cost-spec-2026-08-21.md` — the review cost spec of 2026-08-21, including the open warning that incremental review may raise fix-round cost.
