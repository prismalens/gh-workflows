import { useMemo } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { usePRDetailQuery, usePRsQuery } from "@/api/queries";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ConfigInEffect,
  HeadLadder,
  PRTotals,
  ReportTabs,
} from "@/features/prs/PRDetailPanels";
import { HeadBanner } from "@/features/prs/HeadBanner";
import { enrichPRs, groupRoundsByPR } from "@/features/prs/prs";
import { RoundTimelineCard } from "@/features/prs/RoundTimelineCard";
import { shortSha } from "@/lib/format";
import { rootRoute } from "./root";

export const prDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prs/$owner/$repo/$number",
  component: PRDetailPage,
});

function PRDetailPage() {
  const { owner, repo, number } = prDetailRoute.useParams();
  const repository = `${owner}/${repo}`;
  // Reject malformed PR numbers like "12abc" before querying (finding 3943781319).
  const isValidPrNumber = /^\d+$/.test(number) && Number(number) > 0;
  const prNumber = isValidPrNumber ? Number(number) : null;

  const prQuery = usePRDetailQuery(repository, prNumber);
  const prsQuery = usePRsQuery({ repository });

  const pr = useMemo(() => {
    if (!prQuery.data || !prQuery.data.found) return null;
    const summaries = groupRoundsByPR(prQuery.data.rounds);
    const base = summaries[0] ?? null;
    if (!base) return null;
    // Same enrichment as the index (#141): a prs row replaces title, state, author.
    return enrichPRs([base], prsQuery.data?.rows ?? [])[0] ?? base;
  }, [prQuery.data, prsQuery.data]);

  return (
    <div className="flex flex-col gap-5">
      {/* Top back & title line */}
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/prs">
            <ArrowLeft className="size-4" /> Pull requests
          </Link>
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          {owner}/{repo}#{number}
        </span>
      </div>

      {!isValidPrNumber ? (
        <Alert variant="muted">
          <AlertTitle>This pull request was not found</AlertTitle>
          <AlertDescription>
            No review rounds were found for {owner}/{repo}#{number} in the readable telemetry window.{" "}
            <Link to="/prs" className="underline underline-offset-4">
              Back to pull requests
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : prQuery.isPending ? (
        <LoadingRows rows={5} label="Loading this pull request" />
      ) : prQuery.isError ? (
        <QueryError error={prQuery.error} title="Could not load this pull request" />
      ) : !prQuery.data.found || !pr ? (
        <Alert variant="muted">
          <AlertTitle>This pull request was not found</AlertTitle>
          <AlertDescription>
            No review rounds were found for {owner}/{repo}#{number} in the readable telemetry window.{" "}
            <Link to="/prs" className="underline underline-offset-4">
              Back to pull requests
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-6">
          {/* PR Title & Status line */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-base font-semibold tracking-tight text-foreground">
                PR #{pr.number} · {pr.title}
              </h1>
              <Badge
                variant={pr.state === "open" ? "outline" : "default"}
                className={
                  pr.state === "open"
                    ? "border-emerald-600/40 text-emerald-500 bg-emerald-500/10"
                    : "text-muted-foreground"
                }
              >
                {pr.state}
              </Badge>
              <span className="text-xs text-muted-foreground">by {pr.author}</span>
              {pr.headSha && (
                <span className="font-mono text-xs text-muted-foreground">
                  head {shortSha(pr.headSha)}
                </span>
              )}
            </div>

            {pr.url && (
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Open on GitHub <ExternalLink className="size-3" />
              </a>
            )}
          </div>

          {/* Head banner answering "has this head been read" (#75) */}
          <HeadBanner status={pr.headStatus} />

          {/* Main 2-column layout: Timeline on left, Ladder/Config/Totals on right */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left column: 2 spans */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="text-xs font-semibold pb-3 mb-4 border-b border-border/40">
                  Rounds on this PR ({pr.rounds.length})
                </div>
                <div className="flex flex-col">
                  {pr.rounds.map((round, idx) => (
                    <RoundTimelineCard
                      key={round.session_id}
                      round={round}
                      index={idx}
                      totalRounds={pr.rounds.length}
                    />
                  ))}
                </div>
              </div>

              {/* Report tabs (#75) */}
              <ReportTabs pr={pr} />
            </div>

            {/* Right column: 1 span */}
            <div className="flex flex-col gap-4">
              <HeadLadder pr={pr} />
              <ConfigInEffect pr={pr} />
              <PRTotals pr={pr} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
