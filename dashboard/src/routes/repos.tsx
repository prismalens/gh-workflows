import { useMemo } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { useFleetReposQuery } from "@/api/queries";
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
import { malformedConfigs, quietRepos, repoParams, summariseRepos } from "@/features/repos/repos";
import { WatchOut } from "@/features/repos/WatchOut";
import { Degraded } from "@/honesty/Degraded";
import { linkableRange, standardRangeSchema } from "@/honesty/range";
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

  // One request, and a Fleet one (#185): the window, the all-time denominator,
  // each repository's last round and the malformed-config verdicts all arrive
  // as aggregates, so no row route is read here.
  const fleet = useFleetReposQuery(linkableRange(search.range));

  const rows = fleet.data?.repositories ?? EMPTY_ROWS;
  const repos = useMemo(() => summariseRepos(rows), [rows]);
  const active = repos.filter((repo) => repo.rounds > 0).length;
  const denials = repos.reduce((sum, repo) => sum + repo.denials, 0);
  const windowLabel = fleet.data?.window.label ?? "";

  const malformedItems = fleet.data?.malformed_configs ?? EMPTY_ROWS;
  const malformed = useMemo(() => malformedConfigs(malformedItems), [malformedItems]);
  const quiet = useMemo(() => quietRepos(rows), [rows]);
  const lastRecordedByRepo = useMemo(
    () => new Map(rows.map((r) => [r.repository, r.last_recorded_at])),
    [rows],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold tracking-tight">Repos</h1>
      </div>

      {fleet.isPending ? (
        <LoadingRows label="Loading repositories" />
      ) : fleet.isError ? (
        <QueryError error={fleet.error} title="Could not load repositories" />
      ) : (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <CountTile
              label="Repositories posting"
              count={repos.length}
              detail={`${active} posted over ${windowLabel}`}
              support="repositories that have ever posted a round, which is not the same as repositories configured"
            />
            <CountTile
              label="Rounds"
              count={fleet.data.rounds}
              detail={`over ${windowLabel}`}
            />
            <CountTile
              label="Permission denials"
              count={denials}
              detail="summed across every repository in the window"
            />
          </section>

          <WatchOut
            malformed={malformed}
            quiet={quiet}
            range={search.range}
            windowLabel={windowLabel}
          />

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
                  {repos.map((repo) => {
                    const params = repoParams(repo.repository);
                    return (
                    <TableRow key={repo.repository}>
                      <TableCell className="whitespace-nowrap">
                        {params ? (
                          <Link
                            to="/repos/$owner/$repo"
                            params={params}
                            className="underline-offset-4 hover:underline"
                          >
                            {repo.repository}
                          </Link>
                        ) : (
                          repo.repository
                        )}
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
                            <Timestamp iso={repo.lastRound.recorded_at} compact />
                          </Link>
                        ) : lastRecordedByRepo.get(repo.repository) ? (
                          // Quiet in this window: last_recorded_at is all-time, so the
                          // row still knows when it last posted (#142 finding 3944697641).
                          <Timestamp
                            iso={lastRecordedByRepo.get(repo.repository) ?? null}
                            compact
                          />
                        ) : (
                          <span className="text-muted-foreground">no round ever recorded</span>
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
                    );
                  })}
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
            A repository with no round in this window is still listed.
          </p>
        </>
      )}
    </div>
  );
}
