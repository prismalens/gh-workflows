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
import { OutcomeStrip, RoundLines } from "@/features/prs/PROutcome";
import { DEFAULT_RANGE } from "@/honesty/range";
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
          <Link to="/inbox" search={{ range: DEFAULT_RANGE }}>
            <ArrowLeft className="size-4" /> Inbox
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

          <OutcomeStrip pr={pr} />

          {/* Head banner answering "has this head been read" (#75), and the next action */}
          <HeadBanner status={pr.headStatus} />

          <RoundLines pr={pr} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
              <ReportTabs pr={pr} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <HeadLadder pr={pr} />
              <details className="rounded-lg border border-border bg-card" data-testid="config-drawer">
                <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">Config this PR ran under</summary>
                <div className="overflow-x-auto px-1 pb-2 break-all">
                  <ConfigInEffect pr={pr} />
                </div>
              </details>
              <PRTotals pr={pr} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
