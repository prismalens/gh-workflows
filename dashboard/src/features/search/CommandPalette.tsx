import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { useFindingsQuery, useFleetReposQuery, useRoundsQuery } from "@/api/queries";
import { cn } from "@/lib/utils";
import { searchAll, type SearchResult } from "./searchIndex";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** `/` or Ctrl/Cmd+K anywhere opens the palette; a list's own filter box keeps `/` while focused. */
export function usePaletteHotkey(open: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !isTyping(e.target) && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const now = useMemo(() => new Date(), []);
  const rounds = useRoundsQuery({ range: "30d" }, now);
  const findings = useFindingsQuery();
  const fleet = useFleetReposQuery("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(
    () =>
      searchAll(query, {
        rounds: rounds.data?.rows ?? [],
        findings: findings.data?.rows ?? [],
        repositories: (fleet.data?.repositories ?? []).map((r) => r.repository),
      }),
    [query, rounds.data, findings.data, fleet.data],
  );

  useEffect(() => setActive(0), [query]);

  function go(result: SearchResult | undefined) {
    if (!result) return;
    onClose();
    const t = result.target;
    if ("params" in t) void navigate({ to: t.to, params: t.params } as never);
    else if ("search" in t) void navigate({ to: t.to, search: t.search } as never);
    else void navigate({ to: t.to } as never);
  }

  const groups: { kind: string; items: { r: SearchResult; i: number }[] }[] = [];
  results.forEach((r, i) => {
    const g = groups.find((x) => x.kind === r.kind);
    if (g) g.items.push({ r, i });
    else groups.push({ kind: r.kind, items: [{ r, i }] });
  });
  const ordered = groups.flatMap((g) => g.items.map((x) => x.r));

  return (
    <div className="fixed inset-0 z-50 bg-black/55" onMouseDown={onClose} data-testid="command-palette">
      <div
        role="dialog"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
        className="mx-auto mt-24 flex w-[min(680px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            aria-label="Search everything"
            placeholder="Repository, PR title, #123, owner/repo#123, a path, a sha or a session id"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                setActive((a) => Math.min(ordered.length - 1, a + 1));
                e.preventDefault();
              } else if (e.key === "ArrowUp") {
                setActive((a) => Math.max(0, a - 1));
                e.preventDefault();
              } else if (e.key === "Enter") {
                go(ordered[active]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1" role="listbox" aria-label="Results">
          {ordered.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Nothing matches. Try part of a repository name, a PR number or a file path.
            </p>
          )}
          {(() => {
            let idx = -1;
            return groups.map((g) => (
              <div key={g.kind}>
                <div className="px-4 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
                  {g.kind === "repository" ? "Repositories" : g.kind === "pull request" ? "Pull requests" : g.kind === "finding" ? "Findings" : g.kind === "round" ? "Rounds" : g.kind === "filter" ? "Filters" : "Go to"}
                </div>
                {g.items.map(({ r }) => {
                  idx += 1;
                  const mine = idx;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="option"
                      aria-selected={mine === active}
                      onMouseEnter={() => setActive(mine)}
                      onClick={() => go(r)}
                      className={cn("flex w-full items-center gap-3 px-4 py-1.5 text-left text-xs", mine === active && "bg-muted")}
                    >
                      <span className={cn("truncate", (r.kind === "finding" || r.kind === "filter") && "font-mono")}>{r.title}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{r.detail}</span>
                    </button>
                  );
                })}
              </div>
            ));
          })()}
        </div>
        <div className="flex flex-wrap gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>↑ ↓ move</span>
          <span>Enter open</span>
          <span>Esc close</span>
          <span className="ml-auto">
            <span className="font-mono">repo:</span> <span className="font-mono">fate:</span> <span className="font-mono">path:</span> filter Findings
          </span>
        </div>
      </div>
    </div>
  );
}
