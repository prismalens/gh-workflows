import { useMemo, useState } from "react";
import { createRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { useFindingsQuery, useFleetReposQuery, usePRsQuery, useRoundsQuery } from "@/api/queries";
import type { FindingRow, PrRow, RoundRow } from "@/api/types";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Timestamp } from "@/components/Timestamp";
import { Card } from "@/components/ui/card";
import { AgeChip } from "@/features/findings/FindingsExplorer";
import { buildToday, type NeedItem, type RepoLine, type WeekStat } from "@/features/today/today";
import { DEFAULT_RANGE } from "@/honesty/range";
import { formatCount, formatDuration, formatPercent, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { rootRoute } from "./root";

const EMPTY_ROUNDS: RoundRow[] = [];
const EMPTY_PRS: PrRow[] = [];
const EMPTY_FINDINGS: FindingRow[] = [];
const NEEDS_SHOWN = 7;

export const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const ACTION = "inline-flex items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-semibold whitespace-nowrap hover:border-muted-foreground";

/**
 * The Console's home (#209): what broke, what needs a person, what changed.
 * Rounds cover 30 days so this week can be set against the week before.
 */
function HomePage() {
  const now = useMemo(() => new Date(), []);
  const rounds = useRoundsQuery({ range: "30d" }, now);
  const prs = usePRsQuery();
  const findings = useFindingsQuery();
  const fleet = useFleetReposQuery("rolling");

  const model = useMemo(
    () =>
      buildToday({
        rounds: rounds.data?.rows ?? EMPTY_ROUNDS,
        prs: prs.data?.rows ?? EMPTY_PRS,
        findings: findings.data?.rows ?? EMPTY_FINDINGS,
        fleet: fleet.data,
        now,
      }),
    [rounds.data, prs.data, findings.data, fleet.data, now],
  );

  if (rounds.isPending) return <LoadingRows rows={8} label="Loading home" />;
  if (rounds.isError) return <QueryError error={rounds.error} title="Could not load rounds" />;

  // An unloaded source is unknown, never clean: no "Nothing needs you" or "Nothing is broken" on a guess.
  const prsLoaded = prs.data !== undefined;
  const findingsLoaded = findings.data !== undefined;
  const fleetLoaded = fleet.data !== undefined;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Home</h1>
          <p className="text-xs text-muted-foreground">
            What broke, what needs you, and what changed. Everything else is one click down.
          </p>
        </div>
      </div>

      <StatusStrip
        problems={model.problems}
        lastRoundAt={model.lastRoundAt}
        repositories={model.repositoriesPosting}
        fleet={fleetLoaded ? "loaded" : fleet.isError ? "failed" : "pending"}
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        {prs.isError && !prsLoaded ? (
          <QueryError error={prs.error} title="Could not load pull request state, so Needs you is not listed" />
        ) : findings.isError && !findingsLoaded ? (
          <div className="flex flex-col gap-2">
            <QueryError error={findings.error} title="Could not load findings, so unanswered threads are not listed" />
            <NeedsYou needs={model.needs} now={now} state="partial" />
          </div>
        ) : (
          <NeedsYou needs={model.needs} now={now} state={prsLoaded && findingsLoaded ? "complete" : "loading"} />
        )}
        <div className="flex flex-col gap-4">
          {model.anomalies.map((a) => (
            <section
              key={a.id}
              data-testid="anomaly"
              className="flex flex-col gap-2 rounded-lg border border-[var(--warning)]/50 bg-[var(--warning)]/10 px-4 py-3"
            >
              <span className="text-[10.5px] font-semibold tracking-wide text-[var(--warning)] uppercase">Unusual this week</span>
              <span className="text-lg leading-snug font-semibold">{a.title}</span>
              <span className="text-xs text-muted-foreground">{a.detail}</span>
              {a.link && a.repository && a.link.to === "/rounds" && (
                <Link to="/rounds" search={{ range: DEFAULT_RANGE, repository: a.repository }} className={cn(ACTION, "self-start")}>
                  See the rounds
                </Link>
              )}
              {a.link && a.repository && a.link.to === "/repos/$owner/$repo" && (
                <Link
                  to="/repos/$owner/$repo"
                  params={{ owner: a.repository.split("/")[0] ?? "", repo: a.repository.split("/")[1] ?? "" }}
                  className={cn(ACTION, "self-start")}
                >
                  Open the repository
                </Link>
              )}
            </section>
          ))}
          <WeekCard week={model.week} />
        </div>
      </div>

      <ReposCard repos={model.repos} threadsKnown={findingsLoaded} />
    </div>
  );
}

function StatusStrip({
  problems,
  lastRoundAt,
  repositories,
  fleet,
}: {
  problems: string[];
  lastRoundAt: string | null;
  repositories: number;
  fleet: "loaded" | "pending" | "failed";
}) {
  const ok = problems.length === 0 && fleet === "loaded";
  const unknown = problems.length === 0 && fleet !== "loaded";
  return (
    <div
      data-testid="status-strip"
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-4 py-2.5 text-xs",
        ok ? "border-emerald-500/40 bg-emerald-500/10" : unknown ? "border-border bg-muted/40" : "border-[var(--warning)]/50 bg-[var(--warning)]/10",
      )}
    >
      <span className={cn("size-2.5 rounded-full", ok ? "bg-emerald-400" : unknown ? "bg-muted-foreground" : "bg-[var(--warning)]")} aria-hidden />
      {ok ? (
        <b>Nothing is broken</b>
      ) : unknown ? (
        <b>{fleet === "pending" ? "Reading config state…" : "Config state could not load, so config problems are unknown"}</b>
      ) : (
        <span className="flex flex-col">
          <b>{problems.length === 1 ? "1 problem" : `${problems.length} problems`}</b>
          {problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </span>
      )}
      <span className="ml-auto text-muted-foreground">
        Last round <Timestamp iso={lastRoundAt} compact /> · {formatCount(repositories)} repositor
        {repositories === 1 ? "y" : "ies"} posting this week
      </span>
    </div>
  );
}

function NeedsYou({ needs, now, state }: { needs: NeedItem[]; now: Date; state: "complete" | "partial" | "loading" }) {
  const [all, setAll] = useState(false);
  const shown = all ? needs : needs.slice(0, NEEDS_SHOWN);
  return (
    <Card data-testid="needs-you">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold">Needs you</h2>
        <span className="tabular text-sm font-semibold" title={state === "complete" ? undefined : "partial: unanswered threads are not counted yet"}>
          {formatCount(needs.length)}
          {state !== "complete" && "+"}
        </span>
        {state !== "complete" && needs.length > 0 && (
          <span className="text-xs text-[var(--warning)]">{state === "loading" ? "so far; still reading findings" : "heads only; threads unknown"}</span>
        )}
        <span className="text-xs text-muted-foreground">Ranked by severity, then age. Each row says what to do.</span>
        <Link to="/inbox" search={{ range: DEFAULT_RANGE }} className="ml-auto text-xs text-[var(--chart-1)] hover:underline">
          Open Inbox
        </Link>
      </div>
      {needs.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {state === "loading"
            ? "Reading pull requests and findings…"
            : state === "partial"
              ? "No head needs you; threads are unknown until findings load."
              : "Nothing needs you. Every open head is reviewed and every thread is answered."}
        </p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {shown.map((n) => (
              <NeedRow key={n.id} need={n} now={now} />
            ))}
          </tbody>
        </table>
      )}
      {needs.length > NEEDS_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
          {all ? "Show fewer" : `Show all ${needs.length}`}
        </button>
      )}
    </Card>
  );
}

function NeedRow({ need, now }: { need: NeedItem; now: Date }) {
  const [copied, setCopied] = useState(false);
  const [owner, repo] = need.repository.split("/");
  const params = { owner: owner ?? "", repo: repo ?? "", number: String(need.prNumber) };
  const url = `https://github.com/${need.repository}/pull/${need.prNumber}`;
  return (
    <tr data-testid="need-row" className="border-b border-border last:border-0">
      <td className="w-14 px-4 py-2 align-top">
        <AgeChip iso={need.since} now={now} />
      </td>
      <td className="py-2 align-top">
        <div>{need.what}</div>
        {need.detail && <div className="truncate font-mono text-[11px] text-muted-foreground" title={need.detail}>{need.detail}</div>}
      </td>
      <td className="w-52 px-2 py-2 align-top text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Link to="/prs/$owner/$repo/$number" params={params} className="hover:underline">
            {repo} <span className="font-mono">#{need.prNumber}</span>
          </Link>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${need.repository}#${need.prNumber} on GitHub`}
            title="Open on GitHub"
            className="inline-flex text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </span>
      </td>
      <td className="w-44 px-4 py-2 text-right align-top">
        {need.copyText ? (
          <button
            type="button"
            className={ACTION}
            onClick={() => {
              void navigator.clipboard?.writeText(need.copyText ?? "");
              setCopied(true);
            }}
          >
            {copied ? "Copied" : need.action}
          </button>
        ) : need.kind === "never-answered" || need.kind === "pushback" ? (
          <Link
            to="/findings"
            search={{
              repository: need.repository,
              pr: String(need.prNumber),
              fate: need.kind === "pushback" ? "pushback-open" : "never-answered",
            }}
            className={ACTION}
          >
            {need.action}
          </Link>
        ) : (
          <Link to="/prs/$owner/$repo/$number" params={params} className={ACTION}>
            {need.action}
          </Link>
        )}
      </td>
    </tr>
  );
}

function formatStat(value: number | null, format: WeekStat["format"]): string {
  if (value === null) return "—";
  if (format === "duration") return formatDuration(value);
  if (format === "percent") return formatPercent(value);
  return formatCount(value);
}

function Delta({ stat }: { stat: WeekStat }) {
  if (stat.value === null) return <span className="text-muted-foreground">not comparable</span>;
  if (stat.previous === null) {
    return <span className="text-muted-foreground">{stat.previousWithheld ? "earlier week withheld, low n" : "no earlier figure"}</span>;
  }
  const diff = stat.value - stat.previous;
  const rel = stat.previous === 0 ? null : diff / stat.previous;
  if (diff === 0 || (rel !== null && Math.abs(rel) < 0.1)) return <span className="text-muted-foreground">about the same</span>;
  const up = diff > 0;
  const bad = stat.worseWhen !== null && (stat.worseWhen === "up") === up;
  const good = stat.worseWhen !== null && !bad;
  const text =
    stat.format === "percent"
      ? `${up ? "+" : "−"}${Math.abs(diff * 100).toFixed(1)} pts`
      : stat.format === "duration"
        ? `${up ? "+" : "−"}${formatDuration(Math.abs(diff))}`
        : `${up ? "+" : "−"}${formatCount(Math.abs(diff))}`;
  return (
    <span className={cn("font-semibold", bad && "text-[var(--destructive)]", good && "text-emerald-400", !bad && !good && "text-muted-foreground")}>
      {up ? "▲" : "▼"} {text}
    </span>
  );
}

function WeekCard({ week }: { week: WeekStat[] }) {
  return (
    <Card data-testid="this-week" className="px-4 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">This week</h2>
        <span className="text-xs text-muted-foreground">against the 7 days before</span>
      </div>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {week.map((s) => (
            <tr key={s.label} className="border-b border-border last:border-0">
              <td className="py-1.5">
                {s.label}
                {s.note && <div className="text-[11px] text-muted-foreground">{s.note}</div>}
              </td>
              <td className="tabular py-1.5 text-right font-semibold">{formatStat(s.value, s.format)}</td>
              <td className="w-32 py-1.5 text-right text-[11.5px]">
                <Delta stat={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link to="/fleet" search={{ range: DEFAULT_RANGE }} className="mt-2 inline-block text-xs text-[var(--chart-1)] hover:underline">
        Open Fleet for the charts
      </Link>
    </Card>
  );
}

const STATE_TONE: Record<RepoLine["state"], string> = {
  failing: "text-[var(--destructive)]",
  "config malformed": "text-[var(--warning)]",
  "tool denials": "text-[var(--warning)]",
  quiet: "text-muted-foreground",
  reviewing: "text-emerald-400",
};

function ReposCard({ repos, threadsKnown }: { repos: RepoLine[]; threadsKnown: boolean }) {
  if (repos.length === 0) return null;
  return (
    <Card data-testid="today-repos">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-border bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold">Repositories</h2>
        <span className="text-xs text-muted-foreground">Worst first; the bars are rounds per day this week.</span>
        <Link to="/repos" search={{ range: DEFAULT_RANGE }} className="ml-auto text-xs text-[var(--chart-1)] hover:underline">
          Open Repos
        </Link>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Repository</th>
            <th className="px-2 py-2 font-medium">State</th>
            <th className="px-2 py-2 font-medium">Rounds, 7 days</th>
            <th className="px-2 py-2 text-right font-medium">Rounds</th>
            <th className="px-2 py-2 text-right font-medium">Denials</th>
            <th className="px-2 py-2 text-right font-medium">Open threads</th>
            <th className="px-4 py-2 text-right font-medium">Last round</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((r) => {
            const max = Math.max(1, ...r.perDay);
            const [owner, repo] = r.repository.split("/");
            return (
              <tr key={r.repository} className="border-t border-border">
                <td className="px-4 py-2">
                  <Link to="/repos/$owner/$repo" params={{ owner: owner ?? "", repo: repo ?? "" }} className="hover:underline">
                    {r.repository}
                  </Link>
                </td>
                <td className={cn("px-2 py-2 font-semibold", STATE_TONE[r.state])}>{r.state}</td>
                <td className="px-2 py-2">
                  <div className="flex h-5 items-end gap-0.5" aria-label={`rounds per day: ${r.perDay.join(", ")}`}>
                    {r.perDay.map((n, i) => (
                      <span key={i} className="w-1.5 rounded-[1px] bg-[var(--chart-1)]" style={{ height: `${Math.max(2, (n / max) * 20)}px`, opacity: n ? 0.85 : 0.3 }} />
                    ))}
                  </div>
                </td>
                <td className="tabular px-2 py-2 text-right">{formatCount(r.rounds)}</td>
                <td
                  className={cn("tabular px-2 py-2 text-right", r.state === "tool denials" && "text-[var(--warning)]")}
                  title={r.denials === null ? "permission_denials not recorded" : r.denialRounds < r.rounds ? `permission_denials recorded on ${r.denialRounds} of ${r.rounds} rounds` : undefined}
                >
                  {r.denials === null ? "not recorded" : `${formatCount(r.denials)}${r.denialRounds < r.rounds ? "*" : ""}`}
                </td>
                <td className="tabular px-2 py-2 text-right" title={threadsKnown ? undefined : "findings not loaded"}>
                  {threadsKnown ? formatCount(r.openThreads) : "—"}
                </td>
                <td className="px-4 py-2 text-right text-muted-foreground" title={r.lastRoundAt ?? undefined}>
                  {formatRelative(r.lastRoundAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
