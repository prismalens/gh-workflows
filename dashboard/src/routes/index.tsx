import { useMemo, useState } from "react";

function CopyHint({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copies ${text}; paste it as a PR comment`}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
      className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 font-semibold whitespace-nowrap hover:border-muted-foreground"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
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
import { FilterBar } from "@/components/FilterBar";
import type { FilterKey, FilterToken } from "@/features/filters/grammar";
import { formatCount } from "@/lib/format";
import { rootRoute } from "./root";

const EMPTY_ROWS: RoundRow[] = [];

const inboxSearchSchema = z.object({
  range: standardRangeSchema,
  q: z.string().min(1).optional().catch(undefined),
  repo: z.string().min(1).optional().catch(undefined),
  author: z.string().min(1).optional().catch(undefined),
});

const INBOX_KEYS: FilterKey[] = ["repo", "author"];

/** The one thing to do about a PR in each bucket (#209); none where nothing is asked of anyone. */
const NEXT_ACTION: Partial<Record<InboxBucketKey, string>> = {
  failed: "Copy @claude review",
  "did-not-run": "Copy @claude review",
  "threads-open": "See the threads",
};

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
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
    blurb: "Reviewed, but no prs row carries their open findings yet (#211), so they are not counted healthy.",
  },
];

/**
 * The Console's home (#185): open pull requests across every repository, from
 * the same rounds-plus-prs join as /prs, in the order they need a person.
 */
function InboxPage() {
  const search = indexRoute.useSearch();
  const navigate = indexRoute.useNavigate();
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
    const needle = search.q?.trim().toLowerCase();
    const repo = search.repo?.toLowerCase();
    const author = search.author?.toLowerCase();
    return bucketInbox(
      openPrs.filter(
        (pr) =>
          (!needle || matchesInboxSearch(pr, needle)) &&
          (!repo || pr.repository.toLowerCase().includes(repo)) &&
          (!author || pr.author.toLowerCase().includes(author)),
      ),
    );
  }, [openPrs, search.q, search.repo, search.author]);

  const tokens: FilterToken[] = [
    ...(search.repo ? [{ key: "repo" as const, value: search.repo }] : []),
    ...(search.author ? [{ key: "author" as const, value: search.author }] : []),
  ];
  // Unknown open findings ask nothing of anyone, so that bucket folds like healthy (#209).
  const ACTIVE = SECTIONS.filter((section) => section.key !== "findings-not-recorded");
  const empty = ACTIVE.filter((section) => buckets[section.key].length === 0);
  const filled = ACTIVE.filter((section) => buckets[section.key].length > 0);

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

      <FilterBar
        keys={INBOX_KEYS}
        tokens={tokens}
        text={search.q ?? ""}
        placeholder="Search repository, title, author, or repo:  author:"
        onChange={({ tokens: next, text }) =>
          void navigate({
            search: (prev) => ({
              ...prev,
              repo: next.find((t) => t.key === "repo")?.value,
              author: next.find((t) => t.key === "author")?.value,
              q: text.trim() || undefined,
            }),
          })
        }
      />

      {rounds.isPending || prs.isPending ? (
        <LoadingRows rows={6} label="Loading the inbox" />
      ) : rounds.isError ? (
        <QueryError error={rounds.error} title="Could not load pull requests" />
      ) : prs.isError ? (
        <QueryError error={prs.error} title="Could not load pull request state and findings" />
      ) : (
        <>
          {empty.length > 0 && (
            <div
              data-testid="inbox-empty-sections"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-xs"
            >
              {empty.map((section) => (
                <span key={section.key} data-testid={`inbox-section-${section.key}`}>
                  <span className="font-semibold">{section.title}</span>{" "}
                  <span className="tabular">0</span>
                </span>
              ))}
              <span className="text-muted-foreground">Nothing here needs you.</span>
            </div>
          )}
          {filled.map((section) => (
            <InboxSection
              key={section.key}
              id={section.key}
              title={section.title}
              blurb={section.blurb}
              prs={buckets[section.key]}
            />
          ))}
          <FoldedSection
            testId="inbox-section-findings-not-recorded"
            label={`${formatCount(buckets["findings-not-recorded"].length)} with findings not recorded`}
            blurb={SECTIONS.find((x) => x.key === "findings-not-recorded")!.blurb}
            prs={buckets["findings-not-recorded"]}
          />
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

function FoldedSection({ testId, label, blurb, prs }: { testId: string; label: string; blurb: string; prs: PRSummary[] }) {
  const [open, setOpen] = useState(false);
  if (prs.length === 0) return null;
  return (
    <Card data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="font-medium underline-offset-4 hover:underline"
        >
          {label}
        </button>
        <span className="text-muted-foreground">
          {blurb} {open ? "Shown below." : "Hidden."}
        </span>
      </div>
      {open && <InboxTable prs={prs} />}
    </Card>
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
        <InboxTable prs={prs} action={NEXT_ACTION[id]} />
      )}
    </Card>
  );
}

function InboxTable({ prs, action }: { prs: PRSummary[]; action?: string }) {
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
          {action && <TableHead className="text-right">Next</TableHead>}
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
                {pr.title === `PR #${pr.number}` ? (
                  <span className="text-muted-foreground">title not recorded</span>
                ) : (
                  pr.title
                )}
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
            {action && (
              <TableCell className="text-right text-xs">
                {action === "See the threads" ? (
                  <Link
                    to="/findings"
                    search={{ repository: pr.repository, pr: String(pr.number) }}
                    className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 font-semibold whitespace-nowrap hover:border-muted-foreground"
                  >
                    {action}
                  </Link>
                ) : pr.headStatus.copyableHint ? (
                  <CopyHint text={pr.headStatus.copyableHint} label={action} />
                ) : (
                  <span className="text-muted-foreground">{pr.headStatus.explain}</span>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
