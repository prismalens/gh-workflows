import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatUsd, shortSha } from "@/lib/format";
import type { PRSummary } from "./prs";
import { decodeHeadStatus } from "./headStatus";
import { HeadStatusChip } from "./HeadStatusChip";

export function HeadLadder({ pr }: { pr: PRSummary }) {
  // Unique head SHAs across all rounds, preserved in chronological order seen
  const shasWithRounds = new Map<string, typeof pr.rounds[0]>();
  for (const round of pr.rounds) {
    if (round.head_sha && !shasWithRounds.has(round.head_sha)) {
      shasWithRounds.set(round.head_sha, round);
    }
  }

  // Base of first incremental round if present
  const firstIncremental = [...pr.rounds].reverse().find((r) => r.round_type === "incremental");
  const baseSha = firstIncremental?.range_base;

  return (
    <Card data-testid="head-ladder-card">
      <CardHeader className="py-3 px-4 border-b border-border/40">
        <CardTitle className="text-xs font-semibold">Head ladder</CardTitle>
      </CardHeader>
      <CardContent className="p-3 text-xs flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          {Array.from(shasWithRounds.entries()).map(([sha, round]) => {
            const status = decodeHeadStatus(round);
            return (
              <div key={sha} className="flex items-center justify-between gap-2">
                <span className="font-mono text-foreground font-medium">{shortSha(sha)}</span>
                <HeadStatusChip status={status} />
              </div>
            );
          })}
          {baseSha && !shasWithRounds.has(baseSha) && (
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/30 text-muted-foreground">
              <span className="font-mono">{shortSha(baseSha)}</span>
              <span className="text-[11px]">base of first incremental</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function ConfigInEffect({ pr }: { pr: PRSummary }) {
  const latest = pr.latestRound;
  return (
    <Card data-testid="config-in-effect-card">
      <CardHeader className="py-3 px-4 border-b border-border/40">
        <CardTitle className="text-xs font-semibold">Config in effect</CardTitle>
      </CardHeader>
      <CardContent className="p-3 text-xs flex flex-col gap-2">
        <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">model</dt>
          <dd className="font-mono text-foreground">
            {latest.model ?? "—"} · {latest.model_source ?? "default"}
          </dd>
          {/* Limit and author-skip decisions are not in this data model; match is proven only by model_source (findings 3943781307, 3943781310). */}
          <dt className="text-muted-foreground">auto-pause</dt>
          <dd className="text-foreground">
            automatic-round limit unavailable
          </dd>
          <dt className="text-muted-foreground">path filter</dt>
          <dd className="text-foreground">
            {latest.model_source === "escalated by path match" ? "match" : "no match"}
          </dd>
          <dt className="text-muted-foreground">skip author</dt>
          <dd className="text-foreground">unavailable</dd>
        </dl>
        <div className="pt-2 border-t border-border/30 text-[11px] text-muted-foreground">
          each names its layer after issue 02 ·{" "}
          <Link to="/repos" className="text-primary hover:underline">
            repo config
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export function PRTotals({ pr }: { pr: PRSummary }) {
  const totalDuration = pr.rounds.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0);
  const totalCost = pr.rounds.reduce((acc, r) => acc + (r.total_cost_usd ?? 0), 0);

  return (
    <Card data-testid="pr-totals-card">
      <CardHeader className="py-3 px-4 border-b border-border/40">
        <CardTitle className="text-xs font-semibold">PR totals</CardTitle>
      </CardHeader>
      <CardContent className="p-3 text-xs flex flex-col gap-2">
        <div className="flex flex-col gap-1.5 tabular text-muted-foreground">
          <div>
            rounds <span className="font-semibold text-foreground">{pr.rounds.length}</span> (
            {pr.roundsCountByType.full} full, {pr.roundsCountByType.incremental} incremental,{" "}
            {pr.roundsCountByType.verify} verify)
          </div>
          <div>
            wall clock <span className="font-semibold text-foreground">{formatDuration(totalDuration)}</span>
          </div>
          <div>
            list-rate eq <span className="font-semibold text-foreground">{formatUsd(totalCost)}</span>{" "}
            <span className="text-muted-foreground">across {pr.rounds.length} rounds</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ReportTabs({ pr }: { pr: PRSummary }) {
  const [tab, setTab] = useState<"walkthrough" | "summary" | "findings">("findings");

  return (
    <div className="flex flex-col gap-3" data-testid="report-tabs">
      {/* Tabs bar */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          type="button"
          onClick={() => setTab("walkthrough")}
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            tab === "walkthrough"
              ? "border-b-2 border-primary text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Walkthrough
        </button>
        <button
          type="button"
          onClick={() => setTab("summary")}
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            tab === "summary"
              ? "border-b-2 border-primary text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Summary
        </button>
        <button
          type="button"
          onClick={() => setTab("findings")}
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            tab === "findings"
              ? "border-b-2 border-primary text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Findings
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          walkthrough and summary render stored bodies after issue 08; link cards until then
        </span>
      </div>

      {/* Tab content */}
      <Card>
        <CardHeader className="py-3 px-4 border-b border-border/40 flex-row items-center justify-between gap-2">
          <CardTitle className="text-xs font-semibold">
            {tab === "walkthrough" && "Walkthrough comment"}
            {tab === "summary" && "Summary comment"}
            {tab === "findings" && "Findings and their fate"}
          </CardTitle>
          {tab === "findings" && (
            <Badge variant="warning" className="text-[10px] px-2 py-0.5">
              needs review_findings, #47 · gap G8
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-4 text-xs flex flex-col gap-3">
          {tab === "walkthrough" && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Walkthrough comments are posted to GitHub on each full and incremental round.
                Stored comment bodies land with issue 08.
              </p>
              {pr.url && (
                <div>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    View walkthrough on GitHub <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </div>
          )}

          {tab === "summary" && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Summary comments record the review resolution and audit details.
                Stored comment bodies land with issue 08.
              </p>
              {pr.url && (
                <div>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    View summary on GitHub <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </div>
          )}

          {tab === "findings" && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                Findings tracking is not enabled for this org yet. It ships with the daily sweep
                (gh-workflows#47): each claude[bot] thread, its state, whether a human replied, and
                the commit that followed. Until then, thread fates live on GitHub only.
              </p>
              {pr.url && (
                <div>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    View review threads on GitHub <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
