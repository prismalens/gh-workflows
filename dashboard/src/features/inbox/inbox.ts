import { comparePRsByAttention, type PRSummary } from "@/features/prs/prs";

export type InboxBucketKey = "failed" | "did-not-run" | "threads-open";

export interface InboxBuckets {
  failed: PRSummary[];
  "did-not-run": PRSummary[];
  "threads-open": PRSummary[];
  healthy: PRSummary[];
}

/**
 * Sorts open PRs into the Inbox's three sections (#185). A reviewed head with
 * findings still open is not healthy: it joins threads-only under "Threads open",
 * so "healthy" means reviewed with nothing open, as the IA ruling draws it.
 */
export function bucketInbox(prs: PRSummary[]): InboxBuckets {
  const buckets: InboxBuckets = { failed: [], "did-not-run": [], "threads-open": [], healthy: [] };
  for (const pr of [...prs].sort(comparePRsByAttention)) {
    switch (pr.headStatus.state) {
      case "failed":
      case "did-not-run":
        buckets[pr.headStatus.state].push(pr);
        break;
      case "threads-only":
        buckets["threads-open"].push(pr);
        break;
      case "reviewed":
        if ((pr.openFindings ?? 0) > 0) buckets["threads-open"].push(pr);
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
