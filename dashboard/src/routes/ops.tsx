import { createRoute, Link } from "@tanstack/react-router";

import { useOpsQuery } from "@/api/queries";
import { OPS_IDENTITY_TABLES, type OpsIdentityRow, type OpsIdentityTable } from "@/api/types";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Timestamp } from "@/components/Timestamp";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeAuthCounts, formatBytes, identityStatus, type IdentityStatus } from "@/features/ops/ops";
import { repoParams } from "@/features/repos/repos";
import { CREDENTIAL_COPY } from "@/features/rounds/panels";
import { formatCount } from "@/lib/format";
import { rootRoute } from "./root";

export const opsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ops",
  component: OpsPage,
});

const TABLE_LABEL: Record<OpsIdentityTable, string> = {
  usage_records: "Rounds",
  lane_events: "Lane events",
  prs: "PRs",
  review_findings: "Findings",
};

const STATUS: Record<IdentityStatus, { label: string; variant: "outline" | "warning" }> = {
  "bearer-free": { label: "bearer-free", variant: "outline" },
  "shared-token": { label: "still on the shared token", variant: "warning" },
  "predates-identity": { label: "rows predate identity", variant: "outline" },
};

function RepoLink({ repository }: { repository: string }) {
  const params = repoParams(repository);
  return params ? (
    <Link to="/repos/$owner/$repo" params={params} className="underline-offset-4 hover:underline">
      {repository}
    </Link>
  ) : (
    <>{repository}</>
  );
}

function OpsPage() {
  const ops = useOpsQuery();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Ops</h1>
        <p className="text-xs text-muted-foreground">What runs this install, over the last 7 days.</p>
      </div>

      {ops.isPending ? (
        <LoadingRows label="Loading ops" />
      ) : ops.isError ? (
        <QueryError error={ops.error} title="Could not load ops" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Install</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span data-testid="ops-worker-version">
                Worker{" "}
                {ops.data.worker.version_id ? (
                  <>
                    <b className="font-mono text-foreground">
                      {ops.data.worker.version_tag ?? ops.data.worker.version_id.slice(0, 8)}
                    </b>
                    {ops.data.worker.version_timestamp ? (
                      <>
                        {" · deployed "}
                        <Timestamp iso={ops.data.worker.version_timestamp} compact />
                      </>
                    ) : null}
                  </>
                ) : (
                  "version not reported: the Worker has no version metadata binding"
                )}
              </span>
              <span>
                D1{" "}
                {ops.data.worker.d1_size_bytes !== null ? (
                  <b className="text-foreground">{formatBytes(ops.data.worker.d1_size_bytes)}</b>
                ) : (
                  "size not reported"
                )}
              </span>
            </CardContent>
          </Card>

          <IdentitySection identity={ops.data.identity} />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Credential type, by round</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {ops.data.credentials.length === 0 ? (
                <p className="px-4 pb-4 text-xs text-muted-foreground">No round in the last 7 days.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Repository</TableHead>
                      <TableHead>Credential</TableHead>
                      <TableHead>Rounds</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ops.data.credentials.map((row) => (
                      <TableRow key={`${row.repository}|${row.credential_type ?? ""}`}>
                        <TableCell className="whitespace-nowrap">
                          <RepoLink repository={row.repository} />
                        </TableCell>
                        <TableCell>
                          {row.credential_type === null ? (
                            <span className="text-muted-foreground">not recorded</span>
                          ) : (
                            (CREDENTIAL_COPY[row.credential_type] ?? row.credential_type)
                          )}
                        </TableCell>
                        <TableCell className="tabular">{formatCount(row.rounds)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Weekly health reports received</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {ops.data.health.length === 0 ? (
                <p className="px-4 pb-4 text-xs text-muted-foreground">
                  No health report arrived in the last 7 days.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Repository</TableHead>
                      <TableHead>Reports</TableHead>
                      <TableHead>Runs unaccounted</TableHead>
                      <TableHead>Startup failures</TableHead>
                      <TableHead>Last received</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ops.data.health.map((row) => (
                      <TableRow key={row.repository}>
                        <TableCell className="whitespace-nowrap">
                          <RepoLink repository={row.repository} />
                        </TableCell>
                        <TableCell className="tabular">{formatCount(row.reports)}</TableCell>
                        <TableCell className="tabular">{formatCount(row.unaccounted)}</TableCell>
                        <TableCell className="tabular">{formatCount(row.startup_failures)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Timestamp iso={row.last_received_at} compact />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function IdentitySection({ identity }: { identity: OpsIdentityRow[] }) {
  const bearerFree = identity.filter((row) => identityStatus(row) === "bearer-free").length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">How stats arrived</CardTitle>
        <p className="text-xs text-muted-foreground" data-testid="ops-bearer-free">
          {formatCount(bearerFree)} of {formatCount(identity.length)} repositories bearer-free ·
          alphabetical, never ranked
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {identity.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing arrived in the last 7 days.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                {OPS_IDENTITY_TABLES.map((table) => (
                  <TableHead key={table}>{TABLE_LABEL[table]}</TableHead>
                ))}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {identity.map((row) => {
                const status = STATUS[identityStatus(row)];
                return (
                  <TableRow key={row.repository}>
                    <TableCell className="whitespace-nowrap">
                      <RepoLink repository={row.repository} />
                    </TableCell>
                    {OPS_IDENTITY_TABLES.map((table) => (
                      <TableCell key={table} className="tabular whitespace-nowrap">
                        {describeAuthCounts(row.tables[table])}
                      </TableCell>
                    ))}
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <p className="px-4 py-3 text-xs text-muted-foreground">
          PRs and Findings rows are updated in place, so they show the most recent writer.
        </p>
      </CardContent>
    </Card>
  );
}
