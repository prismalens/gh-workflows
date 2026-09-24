import { useMemo, useState } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { usePRsQuery, useRoundsQuery } from "@/api/queries";
import type { RoundRow } from "@/api/types";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Timestamp } from "@/components/Timestamp";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bucketInbox, matchesInboxSearch, type InboxBucketKey } from "@/features/inbox/inbox";
import { HeadStatusChip } from "@/features/prs/HeadStatusChip";
import { enrichPRs, filterPRsByState, groupRoundsByPR, type PRSummary } from "@/features/prs/prs";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, standardRangeSchema } from "@/honesty/range";
import { formatCount } from "@/lib/format";
import { rootRoute } from "./root";

const EMPTY_ROWS: RoundRow[] = [];

const inboxSearchSchema = z.object({
  range: standardRangeSchema,
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: inboxSearchSchema,
  component: InboxPage,
});

const SECTIONS: { key: InboxBucketKey; title: string; blurb: string }[] = [
  { key: "failed", title: "Failed", blurb: "The lane ran and could not post." },
  {
    key: "did-not-run",
    title: "Did not run",
    blurb: "No review happened on the latest head, and the reason says why.",
  },
  { key: "threads-open", title: "Threads open", blurb: "Findings nobody has closed yet." },
  {
    key: "findings-not-recorded",
    title: "Findings not recorded",
    blurb: "Reviewed, but open_findings is not recorded for these, so they are not counted healthy.",
  },
];

/**
 * The Console's home (#185): open pull requests across every repository, from
 * the same rounds-plus-prs join as /prs, in the order they need a person.
 */
function InboxPage() {
  const search = indexRoute.useSearch();
  const navigate = indexRoute.useNavigate();
  const [query, setQuery] = useState("");
  const [showHealthy, setShowHealthy] = useState(false);

  const now = useMemo(() => new Date(), []);
  const rounds = useRoundsQuery({ range: search.range }, now);
  const prs = usePRsQuery();

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated),
    [fetched, search.range, now, truncated],
  );

  const openPrs = useMemo(
    () => filterPRsByState(enrichPRs(groupRoundsByPR(windowed.rows), prs.data?.rows ?? []), "open"),
    [windowed.rows, prs.data],
  );

  const buckets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return bucketInbox(needle ? openPrs.filter((pr) => matchesInboxSearch(pr, needle)) : openPrs);
  }, [openPrs, query]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-base font-semibold tracking-tight">Inbox</h1>
          <p className="text-xs text-muted-foreground">
            Open pull requests the lane has seen over {windowed.label}, across every repository,
            ranked by what each needs next.
          </p>
        </div>
        <RangeControl
          value={search.range}
          onChange={(range) => void navigate({ search: (prev) => ({ ...prev, range }) })}
        />
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search repository, title, author"
        aria-label="Search the inbox"
        className="h-8 w-full max-w-[360px] rounded-md border border-border bg-transparent px-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      />

      {rounds.isPending || prs.isPending ? (
        <LoadingRows rows={6} label="Loading the inbox" />
      ) : rounds.isError ? (
        <QueryError error={rounds.error} title="Could not load pull requests" />
      ) : prs.isError ? (
        <QueryError error={prs.error} title="Could not load pull request state and findings" />
      ) : (
        <>
          {SECTIONS.map((section) => (
            <InboxSection
              key={section.key}
              id={section.key}
              title={section.title}
              blurb={section.blurb}
              prs={buckets[section.key]}
            />
          ))}
          <Card data-testid="inbox-healthy">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
              <button
                type="button"
                onClick={() => setShowHealthy((v) => !v)}
                aria-expanded={showHealthy}
                className="font-medium underline-offset-4 hover:underline"
              >
                {formatCount(buckets.healthy.length)} healthy
              </button>
              <span className="text-muted-foreground">
                Reviewed, nothing open. {showHealthy ? "Shown below." : "Hidden."}
              </span>
            </div>
            {showHealthy && buckets.healthy.length > 0 && <InboxTable prs={buckets.healthy} />}
          </Card>
          {prs.data?.next_cursor != null && (
            <div className="text-[11px] text-muted-foreground">
              the {formatCount(prs.data.rows.length)} most recently updated pull requests are
              enriched from the prs table; older ones show the state at their last round.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function InboxSection({
  id,
  title,
  blurb,
  prs,
}: {
  id: InboxBucketKey;
  title: string;
  blurb: string;
  prs: PRSummary[];
}) {
  return (
    <Card data-testid={`inbox-section-${id}`}>
      <div className="flex flex-wrap items-baseline gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="tabular text-sm font-semibold">{formatCount(prs.length)}</span>
        <span className="text-xs text-muted-foreground">{blurb}</span>
      </div>
      {prs.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Nothing here.</div>
      ) : (
        <InboxTable prs={prs} />
      )}
    </Card>
  );
}

function InboxTable({ prs }: { prs: PRSummary[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead>Pull request</TableHead>
          <TableHead>Author</TableHead>
          <TableHead>Head</TableHead>
          <TableHead>Why</TableHead>
          <TableHead className="text-right">Open findings</TableHead>
          <TableHead className="text-right">Last round</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {prs.map((pr) => (
          <TableRow key={pr.id}>
            <TableCell className="text-xs text-muted-foreground">{pr.repository}</TableCell>
            <TableCell className="max-w-[420px] truncate text-xs">
              <Link
                to="/prs/$owner/$repo/$number"
                params={{ owner: pr.owner, repo: pr.repo, number: String(pr.number) }}
                className="hover:underline"
                title={pr.title}
              >
                <span className="font-mono font-medium text-primary">#{pr.number}</span>{" "}
                {pr.title}
              </Link>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{pr.author}</TableCell>
            <TableCell>
              <HeadStatusChip status={pr.headStatus} />
            </TableCell>
            <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground">
              {pr.headStatus.rawVerdict ?? pr.headStatus.explain}
            </TableCell>
            <TableCell className="tabular text-right text-xs">
              {pr.openFindings ?? (
                <span
                  className="text-muted-foreground"
                  title="open_findings not recorded for this pull request"
                >
                  not recorded
                </span>
              )}
            </TableCell>
            <TableCell className="text-right text-xs text-muted-foreground">
              <Timestamp iso={pr.lastRoundAt} compact />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
