import type { RoundRow } from "@/api/types";
import { formatTokens } from "@/lib/format";

export interface TokenCompositionBarProps {
  row: RoundRow;
}

/**
 * Token composition as a linear-scale stacked bar (#94 ruling).
 * Log scale is refused because cache read swamping output by orders of
 * magnitude is the honest picture and the entire point.
 */
export function TokenCompositionBar({ row }: { row: RoundRow }) {
  const input = row.input_tokens ?? 0;
  const create = row.cache_creation_input_tokens ?? 0;
  const read = row.cache_read_input_tokens ?? 0;
  const output = row.output_tokens ?? 0;

  const total = input + create + read + output;

  if (total <= 0) {
    return null;
  }

  // Linear scale percentages (#94 ruling: strictly linear, not log)
  const inputPct = (input / total) * 100;
  const createPct = (create / total) * 100;
  const readPct = (read / total) * 100;
  const outputPct = (output / total) * 100;

  const segments = [
    {
      key: "input",
      label: "Input",
      count: row.input_tokens,
      pct: inputPct,
      bg: "bg-blue-500",
      testId: "token-bar-input",
    },
    {
      key: "create",
      label: "Cache creation",
      count: row.cache_creation_input_tokens,
      pct: createPct,
      bg: "bg-amber-500",
      testId: "token-bar-cache-creation",
    },
    {
      key: "read",
      label: "Cache read",
      count: row.cache_read_input_tokens,
      pct: readPct,
      bg: "bg-emerald-500",
      testId: "token-bar-cache-read",
    },
    {
      key: "output",
      label: "Output",
      count: row.output_tokens,
      pct: outputPct,
      bg: "bg-purple-500",
      testId: "token-bar-output",
    },
  ];

  return (
    <div className="flex flex-col gap-2.5 pt-2" data-testid="token-composition-bar" data-scale="linear">
      <div className="flex justify-between items-center text-xs text-muted-foreground">
        <span className="font-medium">Token composition</span>
        <span className="text-[11px] font-mono">linear scale · {formatTokens(total)} total</span>
      </div>

      {/* The linear stacked bar */}
      <div className="w-full h-5 rounded overflow-hidden flex bg-muted/40 border border-border/40">
        {segments.map((s) => {
          if (s.pct <= 0) return null;
          return (
            <div
              key={s.key}
              className={`${s.bg} h-full transition-all`}
              style={{ width: `${s.pct}%` }}
              data-testid={s.testId}
              data-pct={s.pct}
              title={`${s.label}: ${s.count?.toLocaleString() ?? 0} (${s.pct.toFixed(2)}%)`}
            />
          );
        })}
      </div>

      {/* Four raw counts beside / below the bar (#94 ruling) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 font-mono text-xs" data-testid="raw-token-counts">
        {segments.map((s) => (
          <div key={s.key} className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={`size-2 rounded-full ${s.bg} shrink-0`} />
              <span className="truncate">{s.label}</span>
            </div>
            <span className="font-medium text-foreground tabular truncate pl-3.5">
              {s.count !== null && s.count !== undefined ? s.count.toLocaleString() : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
