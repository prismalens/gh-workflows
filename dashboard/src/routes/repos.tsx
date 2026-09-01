import { useMemo } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { useRoundsQuery, useSummaryQuery } from "@/api/queries";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Timestamp } from "@/components/Timestamp";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { summariseRepos } from "@/features/repos/repos";
import { Degraded } from "@/honesty/Degraded";
import { RangeControl } from "@/honesty/RangeControl";
import { applyRange, standardRangeSchema } from "@/honesty/range";
import { CountTile } from "@/honesty/Tile";
import { VERDICT_COPY } from "@/honesty/verdict";
import { formatCount, orDash } from "@/lib/format";
import { rootRoute } from "./root";

const reposSearchSchema = z.object({
  range: standardRangeSchema,
});

export const reposRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos",
  validateSearch: reposSearchSchema,
  component: ReposPage,
});

const EMPTY_ROWS = Object.freeze([]) as never[];

function ReposPage() {
  const search = reposRoute.useSearch();
  const navigate = reposRoute.useNavigate();
  const now = useMemo(() => new Date(), []);

  const summary = useSummaryQuery();
  const rounds = useRoundsQuery({ range: search.range }, now);

  const fetched = rounds.data?.rows ?? EMPTY_ROWS;
  const truncated = rounds.data?.next_cursor != null;
  const windowed = useMemo(
    () => applyRange(fetched, search.range, now, truncated),
    [fetched, search.range, now, truncated],
  );

  // The all-time repository list is this page's denominator, not a decoration.
  // Falling back to [] while it loads would drop every repository that posted
  // outside the window, which is the exact confusion the page exists to prevent:
  // a quiet repository would vanish and the count would silently under-report.
  // So the render waits for it below rather than defaulting it.
  const everPosted = summary.data?.repositories;
  const repos = useMemo(
    () => summariseRepos(windowed.rows, everPosted ?? []),
    [windowed.rows, everPosted],
  );
  const active = repos.filter((repo) => repo.rounds > 0).length;
  const denials = repos.reduce((sum, repo) => sum + repo.denials, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Repos</h1>
        <RangeControl
          value={search.range}
          onChange={(range) => void navigate({ search: () => ({ range }) })}
        />
      </div>

      {rounds.isPending || summary.isPending ? (
        <LoadingRows label="Loading repositories" />
      ) : rounds.isError || summary.isError ? (
        <QueryError
          error={rounds.error ?? summary.error}
          title="Could not load repositories"
        />
      ) : (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <CountTile
              label="Repositories posting"
              count={repos.length}
              detail={`${active} posted over ${windowed.label}`}
              support="repositories that have ever posted a round, which is not the same as repositories configured"
            />
            <CountTile
              label="Rounds"
              count={windowed.rows.length}
              detail={`over ${windowed.label}`}
            />
            <CountTile
              label="Permission denials"
              count={denials}
              detail="summed across every repository in the window"
            />
          </section>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Rounds in window</TableHead>
                    <TableHead>Last round</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Last decoded state</TableHead>
                    <TableHead>Denials</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repos.map((repo) => (
                    <TableRow key={repo.repository}>
                      <TableCell className="whitespace-nowrap">
                        <Link
                          to="/rounds"
                          search={{ range: search.range, repository: repo.repository }}
                          className="underline-offset-4 hover:underline"
                        >
                          {repo.repository}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular">{formatCount(repo.rounds)}</TableCell>
                      <TableCell className="tabular whitespace-nowrap">
                        {repo.lastRound ? (
                          <Link
                            to="/rounds/$sessionId"
                            params={{ sessionId: repo.lastRound.session_id }}
                            search={{ at: repo.lastRound.recorded_at }}
                            className="underline-offset-4 hover:underline"
                          >
                            <Timestamp iso={repo.lastRound.recorded_at} />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            no round over {windowed.label}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{orDash(repo.lastRound?.round_type ?? null)}</TableCell>
                      <TableCell>
                        {repo.lastState ? (
                          <Badge
                            variant={repo.lastState === "reviewed" ? "outline" : "warning"}
                            title={VERDICT_COPY[repo.lastState].explain}
                          >
                            {VERDICT_COPY[repo.lastState].label}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="tabular">{formatCount(repo.denials)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Degraded
            what="Lane, key mode and config state per repository"
            reason="unbuilt"
            detail="Which lane a repository runs, how it authenticates and whether its config layer parsed are properties of the repository, not of a round, and no round carries them. They need the fleet registry, which does not exist (#46)."
          />

          <p className="text-xs text-muted-foreground">
            A repository with no round in this window is still listed. A dead lane and a quiet
            repository look the same here, because a skipped run records nothing.
          </p>
        </>
      )}
    </div>
  );
}
