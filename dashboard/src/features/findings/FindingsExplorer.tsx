import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, X } from "lucide-react";

import type { FindingRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { ageInDays, formatAge, shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FateChip, FixCitedBadge } from "./FateChip";
import { decodeFate, FATE_COPY, fixCitation, prKey } from "./findings";
import { findingBodyText, parseFindingLabel, type Severity } from "./severity";

export function findingPrFilesUrl(row: FindingRow): string {
  return `https://github.com/${row.repository}/pull/${row.pr_number}/files`;
}

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "bg-[var(--destructive)]/25 text-[var(--destructive)]",
  major: "bg-orange-500/20 text-orange-300",
  minor: "bg-yellow-500/15 text-yellow-200",
  nitpick: "bg-muted text-muted-foreground",
};

export function SeverityChip({ severity }: { severity: Severity | null }) {
  if (!severity) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      data-testid="severity-chip"
      className={cn("inline-flex rounded px-1.5 text-[11px] font-semibold capitalize", SEVERITY_STYLE[severity])}
    >
      {severity}
    </span>
  );
}

/** Older is louder: past four weeks red, past a week amber (#209). */
export function AgeChip({ iso, now }: { iso: string | null; now: Date }) {
  const days = ageInDays(iso, now);
  const tone = days === null ? "" : days >= 28 ? "text-[var(--destructive)]" : days >= 7 ? "text-[var(--warning)]" : "text-muted-foreground";
  return (
    <span className={cn("tabular text-[11.5px] font-semibold", tone)} title={iso ?? undefined}>
      {formatAge(iso, now)}
    </span>
  );
}

export interface FindingsListProps {
  rows: FindingRow[];
  selected: string | undefined;
  onSelect: (threadId: string | undefined) => void;
  groupByPr: boolean;
  incompletePrKeys: Set<string>;
  emptyMessage: string;
  now: Date;
}

/**
 * The row list with keyboard movement (#209): j and k move the selection,
 * Enter opens the pull request, Esc closes the peek panel. Keys are ignored
 * while a text box has focus.
 */
export function FindingsList({ rows, selected, onSelect, groupByPr, incompletePrKeys, emptyMessage, now }: FindingsListProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = rows.findIndex((r) => r.thread_node_id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        const next = rows[Math.min(rows.length - 1, idx + 1)];
        if (next) onSelect(next.thread_node_id);
        e.preventDefault();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        const prev = rows[Math.max(0, idx - 1)];
        if (prev) onSelect(prev.thread_node_id);
        e.preventDefault();
      } else if (e.key === "Escape" && selected) {
        onSelect(undefined);
      } else if (e.key === "Enter" && idx >= 0) {
        document.querySelector<HTMLAnchorElement>(`[data-pr-link="${rows[idx]!.thread_node_id}"]`)?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected, onSelect]);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-thread="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  const groups: { key: string; rows: FindingRow[] }[] = [];
  for (const row of rows) {
    const key = groupByPr ? prKey(row) : "";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="w-14 px-3 py-2 font-medium">Age</th>
            <th className="w-20 px-2 py-2 font-medium">Severity</th>
            <th className="px-2 py-2 font-medium">Finding</th>
            <th className="px-2 py-2 font-medium">Where</th>
            <th className="w-36 px-2 py-2 font-medium">Fate</th>
            <th className="w-32 px-3 py-2 font-medium">Fix</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <GroupRows
              key={group.key || group.rows[0]!.thread_node_id}
              group={group}
              showHeader={groupByPr}
              selected={selected}
              onSelect={onSelect}
              incomplete={incompletePrKeys.has(group.key)}
              now={now}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({
  group,
  showHeader,
  selected,
  onSelect,
  incomplete,
  now,
}: {
  group: { key: string; rows: FindingRow[] };
  showHeader: boolean;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  incomplete: boolean;
  now: Date;
}) {
  const first = group.rows[0]!;
  const [owner, repo] = first.repository.split("/");
  return (
    <>
      {showHeader && (
        <tr className="border-b border-border bg-muted/50">
          <td colSpan={6} className="px-3 py-1.5">
            <Link
              to="/prs/$owner/$repo/$number"
              params={{ owner: owner ?? "", repo: repo ?? "", number: String(first.pr_number) }}
              className="font-semibold hover:underline"
            >
              {first.repository} <span className="font-mono">#{first.pr_number}</span>
            </Link>
            <span className="ml-2 text-muted-foreground">
              {group.rows.length} finding{group.rows.length === 1 ? "" : "s"}
            </span>
            {incomplete && (
              <span
                className="ml-2 text-[var(--warning)]"
                title="This pull request's sweep was cut short by a throttle; its findings are a partial set."
              >
                partial sweep
              </span>
            )}
          </td>
        </tr>
      )}
      {group.rows.map((row) => {
        const label = parseFindingLabel(row);
        const body = findingBodyText(row);
        const citation = fixCitation(row);
        const on = row.thread_node_id === selected;
        const [o, r] = row.repository.split("/");
        return (
          <tr
            key={row.thread_node_id}
            data-thread={row.thread_node_id}
            data-testid="finding-row"
            aria-selected={on}
            onClick={() => onSelect(on ? undefined : row.thread_node_id)}
            className={cn(
              "cursor-pointer border-b border-border last:border-0 hover:bg-accent/40",
              on && "bg-[var(--chart-1)]/15 hover:bg-[var(--chart-1)]/20",
            )}
          >
            <td className="px-3 py-1.5">
              <AgeChip iso={row.thread_created_at} now={now} />
            </td>
            <td className="px-2 py-1.5">
              <SeverityChip severity={label.severity} />
            </td>
            <td className="max-w-[360px] truncate px-2 py-1.5" title={body ?? undefined}>
              {label.category && <span className="font-medium">{label.category}</span>}
              {label.category && body && <span className="text-muted-foreground"> · </span>}
              <span className="text-muted-foreground">{body ?? (label.category ? "" : "text not shared")}</span>
            </td>
            <td className="max-w-[300px] truncate px-2 py-1.5 font-mono" title={row.path ?? undefined}>
              {!showHeader && (
                <span className="text-muted-foreground">
                  {row.repository.split("/")[1]}#{row.pr_number}{" "}
                </span>
              )}
              {row.path ?? "—"}
              {row.original_line !== null ? `:${row.original_line}` : ""}
              <Link
                to="/prs/$owner/$repo/$number"
                params={{ owner: o ?? "", repo: r ?? "", number: String(row.pr_number) }}
                data-pr-link={row.thread_node_id}
                className="sr-only"
                tabIndex={-1}
              >
                Open pull request
              </Link>
            </td>
            <td className="px-2 py-1.5">
              <FateChip fate={decodeFate(row)} />
            </td>
            <td className="px-3 py-1.5">{citation ? <FixCitedBadge citation={citation} /> : <span className="text-muted-foreground">—</span>}</td>
          </tr>
        );
      })}
    </>
  );
}

export function FindingPeek({
  row,
  siblings,
  onSelect,
  now,
}: {
  row: FindingRow;
  siblings: FindingRow[];
  onSelect: (id: string | undefined) => void;
  now: Date;
}) {
  const fate = decodeFate(row);
  const label = parseFindingLabel(row);
  const body = findingBodyText(row);
  const citation = fixCitation(row);
  const [owner, repo] = row.repository.split("/");
  return (
    <aside
      aria-label="Finding detail"
      data-testid="finding-peek"
      className="sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-card p-4 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {row.repository} <span className="font-mono">#{row.pr_number}</span>
        </span>
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => onSelect(undefined)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="font-mono text-[13px] break-all">
        {row.path ?? "—"}
        {row.original_line !== null ? `:${row.original_line}` : ""}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FateChip fate={fate} />
        <SeverityChip severity={label.severity} />
        <AgeChip iso={row.thread_created_at} now={now} />
        {label.category && <span className="text-muted-foreground">{label.category}</span>}
      </div>
      <p className="text-muted-foreground">{FATE_COPY[fate].explain}</p>
      <div className="rounded-md bg-muted/60 p-3 leading-relaxed whitespace-pre-wrap">
        {body ?? "The finding's text is not stored for this repository at its share level."}
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">Posted</dt>
        <dd><Timestamp iso={row.thread_created_at} /></dd>
        <dt className="text-muted-foreground">Human replies</dt>
        <dd className="tabular">{row.human_reply_count ?? "not recorded"}</dd>
        <dt className="text-muted-foreground">Verify round</dt>
        <dd>{row.verify_verdict?.replace("_", " ") ?? "not run"}</dd>
        <dt className="text-muted-foreground">Fix commit</dt>
        <dd>{citation ? <FixCitedBadge citation={citation} /> : "none on record"}</dd>
        <dt className="text-muted-foreground">Resolved by</dt>
        <dd>{row.resolved_by_login ?? (row.is_resolved === 1 ? "not on record" : "still open")}</dd>
        {row.head_sha_reviewed && (
          <>
            <dt className="text-muted-foreground">Head reviewed</dt>
            <dd className="font-mono">{shortSha(row.head_sha_reviewed)}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <a
          href={findingPrFilesUrl(row)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-1 font-semibold hover:border-muted-foreground"
        >
          PR files on GitHub <ExternalLink className="size-3" />
        </a>
        <Link
          to="/prs/$owner/$repo/$number"
          params={{ owner: owner ?? "", repo: repo ?? "", number: String(row.pr_number) }}
          className="inline-flex items-center rounded-md border border-border bg-muted px-2.5 py-1 font-semibold hover:border-muted-foreground"
        >
          Open the PR page
        </Link>
      </div>
      {siblings.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <div className="font-semibold">Same pull request</div>
          {siblings.map((s) => (
            <button
              key={s.thread_node_id}
              type="button"
              onClick={() => onSelect(s.thread_node_id)}
              className="flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent"
            >
              <FateChip fate={decodeFate(s)} />
              <span className="truncate font-mono">{s.path ?? "—"}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
