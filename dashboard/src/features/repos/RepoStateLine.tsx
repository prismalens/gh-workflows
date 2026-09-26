import { useMemo } from "react";

import { useFindingsQuery, useFleetReposQuery, usePRsQuery, useRoundsQuery } from "@/api/queries";
import { QueryError } from "@/components/QueryState";
import { buildToday, type RepoLine } from "@/features/today/today";
import { formatCount, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const REPO_STATE_TONE: Record<RepoLine["state"], string> = {
  failing: "text-[var(--destructive)]",
  "config malformed": "text-[var(--warning)]",
  "tool denials": "text-[var(--warning)]",
  quiet: "text-muted-foreground",
  reviewing: "text-emerald-400",
};

/** Home's line for one repository, from the same model, so the two pages cannot disagree (#218). */
export function RepoStateLine({ repository }: { repository: string }) {
  const now = useMemo(() => new Date(), []);
  const rounds = useRoundsQuery({ range: "30d" }, now);
  const prs = usePRsQuery();
  const findings = useFindingsQuery();
  const fleet = useFleetReposQuery("rolling");

  const line = useMemo(() => {
    if (!rounds.data || !fleet.data) return undefined;
    const model = buildToday({
      rounds: rounds.data.rows,
      prs: prs.data?.rows ?? [],
      findings: findings.data?.rows ?? [],
      fleet: fleet.data,
      now,
    });
    return model.repos.find((r) => r.repository === repository) ?? null;
  }, [rounds.data, prs.data, findings.data, fleet.data, now, repository]);

  if (rounds.isError || fleet.isError) {
    return <QueryError error={rounds.error ?? fleet.error} title="Could not load this repository's state" />;
  }
  if (line === undefined) return null;
  return (
    <p data-testid="repo-state-line" className="text-xs text-muted-foreground">
      {line === null ? (
        "No round from this repository in the last 30 days."
      ) : (
        <>
          <span className={cn("font-semibold", REPO_STATE_TONE[line.state])}>{line.state}</span>
          {" · "}
          {formatCount(line.rounds)} round{line.rounds === 1 ? "" : "s"} in 7 days · last round{" "}
          {formatRelative(line.lastRoundAt, now)}
          {findings.data ? ` · ${formatCount(line.openThreads)} open thread${line.openThreads === 1 ? "" : "s"}` : ""}
        </>
      )}
    </p>
  );
}
