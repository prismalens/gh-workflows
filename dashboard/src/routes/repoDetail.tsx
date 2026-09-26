import { useMemo, useState } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import {
  useAttentionQuery,
  useHealthReportsQuery,
  useLaneEventsQuery,
  usePRsQuery,
  useRoundsQuery,
} from "@/api/queries";
import type { LaneEventRow, RoundRow } from "@/api/types";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FallbacksSection } from "@/features/failures/FallbacksSection";
import { LaneEventsSection } from "@/features/failures/LaneEventsSection";
import { ModelResolutionSection } from "@/features/failures/ModelResolutionSection";
import { VerdictSection } from "@/features/failures/VerdictSection";
import { PRsTable } from "@/features/prs/PRsTable";
import { comparePRsByAttention, enrichPRs, groupRoundsByPR } from "@/features/prs/prs";
import { RepoConfig } from "@/features/repos/RepoConfig";
import { WeeklyHealth } from "@/features/repos/WeeklyHealth";
import { applyRange, DEFAULT_RANGE, standardRangeSchema, type RangeKey } from "@/honesty/range";
import { rootRoute } from "./root";

// The Console IA (#185): five tabs, read-only; config edits are pull requests (#78).
const TABS = [
  { key: "prs", label: "PRs" },
  { key: "lane-events", label: "Lane events" },
  { key: "health", label: "Weekly health" },
  { key: "config", label: "Config" },
  { key: "failures", label: "Failures" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const repoSearchSchema = z.object({
  tab: z.enum(["prs", "lane-events", "health", "config", "failures"]).optional().catch(undefined),
  range: standardRangeSchema,
});

export const repoDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$owner/$repo",
  validateSearch: repoSearchSchema,
  component: RepoDetailPage,
});

const EMPTY_ROUNDS: RoundRow[] = [];
const EMPTY_EVENTS: LaneEventRow[] = [];

function RepoDetailPage() {
  const { owner, repo } = repoDetailRoute.useParams();
  const search = repoDetailRoute.useSearch();
  const repository = `${owner}/${repo}`;
  const tab: TabKey = search.tab ?? "prs";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/repos" search={{ range: DEFAULT_RANGE }}>
            <ArrowLeft className="size-4" /> Repos
          </Link>
        </Button>
        <h1 className="font-mono text-base font-semibold tracking-tight">{repository}</h1>
        <Link
          to="/rounds"
          search={{ range: DEFAULT_RANGE, repository }}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Rounds
        </Link>
      </div>

      <div role="tablist" className="flex flex-wrap items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            role="tab"
            aria-selected={t.key === tab}
            to="/repos/$owner/$repo"
            params={{ owner, repo }}
            search={(prev) => ({ ...prev, tab: t.key })}
            className={
              t.key === tab
                ? "border-b-2 border-primary px-3 py-2 text-xs font-semibold text-foreground"
                : "border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "prs" && <PRsTab repository={repository} range={search.range} />}
        {tab === "lane-events" && <LaneEventsTab repository={repository} range={search.range} />}
        {tab === "health" && <HealthTab repository={repository} />}
        {tab === "config" && <ConfigTab repository={repository} range={search.range} />}
        {tab === "failures" && <FailuresTab repository={repository} range={search.range} />}
      </div>
    </div>
  );
}

interface TabProps {
  repository: string;
  range: RangeKey;
}

function useWindowedRounds(repository: string, range: RangeKey, now: Date) {
  const rounds = useRoundsQuery({ range, repository }, now);
  const fetched = rounds.data?.rows ?? EMPTY_ROUNDS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, range, now, truncated),
    [fetched, range, now, truncated],
  );
  return { rounds, windowed };
}

function PRsTab({ repository, range }: TabProps) {
  const now = useMemo(() => new Date(), []);
  const { rounds, windowed } = useWindowedRounds(repository, range, now);
  const prs = usePRsQuery({ repository });
  const [sorting, setSorting] = useState<SortingState>([{ id: "attention", desc: false }]);

  const list = useMemo(() => {
    const all = enrichPRs(groupRoundsByPR(windowed.rows), prs.data?.rows ?? []);
    const first = sorting[0];
    if (!first || first.id === "attention" || first.id === "head_status") {
      all.sort(comparePRsByAttention);
      if (first?.desc) all.reverse();
    }
    return all;
  }, [windowed.rows, prs.data, sorting]);

  if (rounds.isPending || prs.isPending) return <LoadingRows label="Loading pull requests" />;
  const error = rounds.error ?? prs.error;
  if (error) return <QueryError error={error} title="Could not load pull requests" />;
  if (list.length === 0) {
    return (
      <Alert variant="muted">
        <AlertTitle>No pull request had a round over {windowed.label}</AlertTitle>
        <AlertDescription>Either nothing ran on {repository}, or nothing was recorded.</AlertDescription>
      </Alert>
    );
  }
  return <PRsTable prs={list} sorting={sorting} onSortingChange={setSorting} />;
}

function LaneEventsTab({ repository, range }: TabProps) {
  const now = useMemo(() => new Date(), []);
  const events = useLaneEventsQuery({ range, repository }, now);
  if (events.isPending) return <LoadingRows label="Loading lane events" />;
  if (events.isError) return <QueryError error={events.error} title="Could not load lane events" />;
  return (
    <LaneEventsSection
      events={events.data.rows ?? EMPTY_EVENTS}
      now={now}
      range={range}
      repository={repository}
    />
  );
}

function HealthTab({ repository }: { repository: string }) {
  const health = useHealthReportsQuery(repository);
  if (health.isPending) return <LoadingRows rows={4} label="Loading health reports" />;
  if (health.isError) return <QueryError error={health.error} title="Could not load health reports" />;
  if (health.data.rows.length === 0) {
    return (
      <Alert variant="muted">
        <AlertTitle>No health report has arrived for {repository}</AlertTitle>
        <AlertDescription>
          A report arrives once a week from the repository's telemetry-health workflow. None is
          stored for this name.
        </AlertDescription>
      </Alert>
    );
  }
  return <WeeklyHealth rows={health.data.rows} truncated={health.data.next_cursor != null} />;
}

function ConfigTab({ repository, range }: TabProps) {
  const now = useMemo(() => new Date(), []);
  const blobs = useAttentionQuery({ range, repository }, now);
  if (blobs.isPending) return <LoadingRows label="Loading config" />;
  if (blobs.isError) return <QueryError error={blobs.error} title="Could not load config" />;
  return <RepoConfig repository={repository} blobRows={blobs.data.rows} range={range} />;
}

function FailuresTab({ repository, range }: TabProps) {
  const now = useMemo(() => new Date(), []);
  const { rounds, windowed } = useWindowedRounds(repository, range, now);
  const blobs = useAttentionQuery({ range, repository }, now);
  if (rounds.isPending || blobs.isPending) return <LoadingRows label="Loading failures" />;
  const error = rounds.error ?? blobs.error;
  if (error) return <QueryError error={error} title="Could not load failures" />;
  const blobRows = blobs.data?.rows ?? EMPTY_ROUNDS;
  return (
    <div className="flex flex-col gap-6">
      <VerdictSection rows={windowed.rows} now={now} range={range} repository={repository} />
      <FallbacksSection rows={windowed.rows} now={now} range={range} repository={repository} />
      <ModelResolutionSection
        rows={windowed.rows}
        blobRows={blobRows}
        now={now}
        range={range}
        repository={repository}
      />
    </div>
  );
}
