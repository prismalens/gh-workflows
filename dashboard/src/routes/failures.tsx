import { useMemo } from "react";
import { createRoute } from "@tanstack/react-router";
import { z } from "zod";

import { useAttentionQuery, useLaneEventsQuery, useRoundsQuery, useSummaryQuery } from "@/api/queries";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfigSection } from "@/features/failures/ConfigSection";
import { FallbacksSection } from "@/features/failures/FallbacksSection";
import { LaneEventsSection } from "@/features/failures/LaneEventsSection";
import { ModelResolutionSection } from "@/features/failures/ModelResolutionSection";
import { VerdictSection } from "@/features/failures/VerdictSection";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, rangeSchema } from "@/honesty/range";
import { rootRoute } from "./root";

const failuresSearchSchema = z.object({
  range: rangeSchema,
  repository: z.string().min(1).optional().catch(undefined),
});

export const failuresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/failures",
  validateSearch: failuresSearchSchema,
  component: FailuresPage,
});

const EMPTY_ROWS = Object.freeze([]) as never[];

function FailuresPage() {
  const search = failuresRoute.useSearch();
  const navigate = failuresRoute.useNavigate();

  const now = useMemo(() => new Date(), []);
  const filters = { range: search.range, repository: search.repository };

  const summary = useSummaryQuery();
  const rounds = useRoundsQuery(filters, now);
  const attention = useAttentionQuery(filters, now);
  const laneEvents = useLaneEventsQuery(filters, now);

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated),
    [fetched, search.range, now, truncated],
  );

  const events = laneEvents.data?.rows ?? EMPTY_ROWS;
  const blobRows = attention.data?.rows ?? EMPTY_ROWS;

  const isLoading = rounds.isPending || laneEvents.isPending;
  const error = rounds.error ?? laneEvents.error;

  const totalItems = windowed.rows.length + events.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Failure surface</h1>
        <RangeControl
          value={search.range}
          onChange={(range) => void navigate({ search: (prev) => ({ ...prev, range }) })}
        />
        <FilterChips
          label="Repository"
          options={summary.data?.repositories ?? []}
          value={search.repository}
          onChange={(repository) =>
            void navigate({ search: (prev) => ({ ...prev, repository }) })
          }
        />
      </div>

      {isLoading ? (
        <LoadingRows label="Loading failure surface telemetry" />
      ) : error ? (
        <QueryError error={error} title="Could not load failure surface telemetry" />
      ) : totalItems === 0 ? (
        <Alert variant="muted">
          <AlertTitle>No rounds in range</AlertTitle>
          <AlertDescription>
            No rounds or lane events were recorded over {windowed.label}
            {search.repository ? ` for ${search.repository}` : ""}. Not zeros: either nothing ran,
            or nothing was recorded.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {/* Section 1: Liveness verdicts */}
          <VerdictSection
            rows={windowed.rows}
            now={now}
            range={search.range}
            repository={search.repository}
          />

          {/* Section 2: The six incremental fallbacks */}
          <FallbacksSection
            rows={windowed.rows}
            now={now}
            range={search.range}
            repository={search.repository}
          />

          {/* Section 3: Config parse outcomes */}
          <ConfigSection
            blobRows={blobRows}
            range={search.range}
            repository={search.repository}
          />

          {/* Section 4: Model resolution reasons */}
          <ModelResolutionSection
            rows={windowed.rows}
            blobRows={blobRows}
            now={now}
            range={search.range}
            repository={search.repository}
          />

          {/* Section 5: Rounds that never happened */}
          <LaneEventsSection
            events={events}
            now={now}
            range={search.range}
            repository={search.repository}
          />
        </>
      )}
    </div>
  );
}
