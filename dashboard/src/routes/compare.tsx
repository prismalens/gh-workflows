import { useMemo } from "react";
import { createRoute } from "@tanstack/react-router";
import { z } from "zod";

import { useChangesQuery, useRoundsQuery, useSummaryQuery } from "@/api/queries";
import { FilterChips } from "@/components/FilterChips";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { compareRoundTypes, splitRoundsByChange } from "@/features/compare/compare";
import {
  ChangeSelector,
  EmptyChangesView,
  RoundTypeSection,
  WindowSummaryStrip,
} from "@/features/compare/CompareSections";
import { rootRoute } from "./root";

const compareSearchSchema = z.object({
  change: z.string().min(1).optional().catch(undefined),
  repository: z.string().min(1).optional().catch(undefined),
});

export const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compare",
  validateSearch: compareSearchSchema,
  component: ComparePage,
});

function ComparePage() {
  const search = compareRoute.useSearch();
  const navigate = compareRoute.useNavigate();

  const now = useMemo(() => new Date(), []);
  const changesQuery = useChangesQuery();
  const summaryQuery = useSummaryQuery();

  const changes = changesQuery.data?.rows ?? [];

  const selectedChange = useMemo(() => {
    if (changes.length === 0) return null;
    if (search.change) {
      const found = changes.find((c) => c.id === search.change);
      if (found) return found;
    }
    return changes[0];
  }, [changes, search.change]);

  const selectedRepo =
    selectedChange?.scope === "repo" ? selectedChange.repository ?? undefined : search.repository;

  const roundsQuery = useRoundsQuery(
    {
      range: "all",
      repository: selectedRepo,
    },
    now,
  );

  if (changesQuery.isPending) {
    return <LoadingRows label="Loading changes registry" />;
  }

  if (changesQuery.isError) {
    return <QueryError error={changesQuery.error} title="Could not load changes registry" />;
  }

  if (changes.length === 0 || !selectedChange) {
    return <EmptyChangesView />;
  }

  const fetchedRows = roundsQuery.data?.rows ?? [];
  const { beforeRows, afterRows } = splitRoundsByChange(fetchedRows, selectedChange, selectedRepo);
  const roundTypeResults = compareRoundTypes(beforeRows, afterRows);

  const availableRepos = summaryQuery.data?.repositories ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="compare-page">
      <ChangeSelector
        changes={changes}
        selectedChange={selectedChange}
        onSelectChange={(c) => {
          navigate({ search: (prev) => ({ ...prev, change: c.id, repository: undefined }) });
        }}
      />

      {selectedChange.scope === "fleet" && availableRepos.length > 1 && (
        <FilterChips
          label="Repository:"
          options={availableRepos}
          value={search.repository}
          onChange={(repo) => {
            navigate({ search: (prev) => ({ ...prev, repository: repo }) });
          }}
        />
      )}

      {roundsQuery.isPending && <LoadingRows label="Loading review rounds for comparison" />}
      {roundsQuery.isError && <QueryError error={roundsQuery.error} title="Could not load review rounds" />}

      {roundsQuery.isSuccess && (
        <>
          <WindowSummaryStrip
            beforeCount={beforeRows.length}
            afterCount={afterRows.length}
            change={selectedChange}
          />

          {beforeRows.length > 0 && afterRows.length > 0 && roundTypeResults.length === 0 && (
            <Alert variant="muted">
              <AlertTitle>No round types recorded</AlertTitle>
              <AlertDescription>
                Rounds exist in both windows but none specify a round_type column.
              </AlertDescription>
            </Alert>
          )}

          {roundTypeResults.map((result) => (
            <RoundTypeSection key={result.roundType} result={result} />
          ))}
        </>
      )}
    </div>
  );
}
