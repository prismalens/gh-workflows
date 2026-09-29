import { comparePRsByAttention, type PRSummary } from "@/features/prs/prs";

export type InboxBucketKey = "failed" | "did-not-run" | "threads-open" | "findings-not-recorded";

export interface InboxBuckets {
  failed: PRSummary[];
  "did-not-run": PRSummary[];
  "threads-open": PRSummary[];
  "findings-not-recorded": PRSummary[];
  healthy: PRSummary[];
}

/**
 * Sorts open PRs into the Inbox's sections (#185). A verify-only head never read
 * the code, so it sits with did-not-run; "Threads open" is a recorded count (#218).
 * "Healthy" means reviewed
 * with open_findings recorded as zero; a PR no prs row enriched has no count, and
 * an unknown count is its own section rather than a clean result.
 */
export function bucketInbox(prs: PRSummary[]): InboxBuckets {
  const buckets: InboxBuckets = {
    failed: [],
    "did-not-run": [],
    "threads-open": [],
    "findings-not-recorded": [],
    healthy: [],
  };
  for (const pr of [...prs].sort(comparePRsByAttention)) {
    switch (pr.headStatus.state) {
      case "failed":
        buckets.failed.push(pr);
        break;
      case "did-not-run":
      case "threads-only":
        buckets["did-not-run"].push(pr);
        break;
      case "reviewed":
        if (pr.openFindings === null) buckets["findings-not-recorded"].push(pr);
        else if (pr.openFindings > 0) buckets["threads-open"].push(pr);
        else buckets.healthy.push(pr);
        break;
    }
  }
  return buckets;
}

export function matchesInboxSearch(pr: PRSummary, needle: string): boolean {
  return (
    pr.repository.toLowerCase().includes(needle) ||
    pr.title.toLowerCase().includes(needle) ||
    pr.author.toLowerCase().includes(needle)
  );
}
