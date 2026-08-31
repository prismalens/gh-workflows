import { createRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import { ROUND_SCAN_PAGES } from "@/api/client";
import { MAX_LIMIT_WITH_BLOBS } from "@/api/client";
import { useRoundQuery } from "@/api/queries";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DenialsPanel,
  FanOutPanel,
  RawRecordPanel,
  ResolutionPanel,
  TimingPanel,
  TokensPanel,
} from "@/features/rounds/panels";
import { rootRoute } from "./root";

const detailSearchSchema = z.object({
  /**
   * The round's recorded_at. GET /api/runs has no by-id read route, but since
   * and until are inclusive bounds, so this turns the lookup into one request.
   */
  at: z.string().min(1).optional().catch(undefined),
});

export const roundDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rounds/$sessionId",
  validateSearch: detailSearchSchema,
  component: RoundDetailPage,
});

function RoundDetailPage() {
  const { sessionId } = roundDetailRoute.useParams();
  const { at } = roundDetailRoute.useSearch();
  const round = useRoundQuery(sessionId, at);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/rounds">
            <ArrowLeft className="size-4" /> Rounds
          </Link>
        </Button>
        <h1 className="font-mono text-sm">{sessionId}</h1>
      </div>

      {round.isPending ? (
        <LoadingRows rows={4} />
      ) : round.isError ? (
        <QueryError error={round.error} />
      ) : !round.data.found ? (
        <Alert variant="muted">
          <AlertTitle>This round is not in the readable window</AlertTitle>
          <AlertDescription>
            The read route has no lookup by session id. Without a recorded_at to bound the query,
            the most recent {ROUND_SCAN_PAGES * MAX_LIMIT_WITH_BLOBS} rounds are scanned instead,
            and {round.data.scanned} were checked. Open the round from the table so the link
            carries its timestamp.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ResolutionPanel row={round.data.row} />
          <TimingPanel row={round.data.row} />
          <FanOutPanel row={round.data.row} />
          <TokensPanel row={round.data.row} />
          <DenialsPanel row={round.data.row} />
          <RawRecordPanel row={round.data.row} />
        </div>
      )}
    </div>
  );
}
