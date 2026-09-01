import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { ChangeRow } from "@/api/types";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration, formatTokens } from "@/lib/format";
import type { DayBucket, ScatterPoint, TokenDayBucket } from "./activity";

/**
 * Round types keep one colour across every chart on the page, so the same bar and
 * the same dot mean the same thing. Anything unrecognised falls through to the
 * remaining slots rather than colliding with a named type.
 */
const NAMED_SERIES: Record<string, string> = {
  full: "var(--chart-1)",
  review: "var(--chart-1)",
  incremental: "var(--chart-2)",
  verify: "var(--chart-3)",
  untyped: "var(--muted-foreground)",
};
const SPARE_SERIES = ["var(--chart-4)", "var(--chart-5)"];

export function seriesColor(key: string, index: number): string {
  return NAMED_SERIES[key] ?? SPARE_SERIES[index % SPARE_SERIES.length];
}

const AXIS = {
  stroke: "var(--muted-foreground)",
  fontSize: 11,
  tickLine: false,
} as const;

/**
 * Recharts types a tooltip label as ReactNode and a tooltip value as its own
 * union, so both are narrowed here rather than asserted into the shape we want.
 */
function dayLabel(label: ReactNode): ReactNode {
  return typeof label === "string" ? shortDay(label) : label;
}

function tokenValue(value: unknown): ReactNode {
  return typeof value === "number" ? formatTokens(value) : "\u2014";
}

function durationValue(value: unknown): ReactNode {
  return typeof value === "number" ? formatDuration(value) : "\u2014";
}

function stampLabel(label: ReactNode): ReactNode {
  return typeof label === "number"
    ? new Date(label).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")
    : label;
}

/** Aug 31, from a YYYY-MM-DD bucket key, without dragging in a date library. */
function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

interface ChartCardProps {
  title: string;
  /** The swatch row. It is DOM, not an SVG legend, so it carries the totals. */
  legend: ReactNode;
  note?: string;
  children: ReactNode;
}

function ChartCard({ title, legend, note, children }: ChartCardProps) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <div className="h-48 w-full">{children}</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">{legend}</div>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

export function Swatch({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span
        aria-hidden
        className="size-2.5 rounded-[2px]"
        style={{ backgroundColor: color }}
      />
      {children}
    </span>
  );
}

export interface RoundsPerDayChartProps {
  data: DayBucket[];
  types: string[];
  countByType: Record<string, number>;
  changes?: ChangeRow[];
  selectedMarkerId?: string | null;
  onMarkerClick?: (changeId: string) => void;
}

export function RoundsPerDayChart({
  data,
  types,
  countByType,
  changes,
  selectedMarkerId,
  onMarkerClick,
}: RoundsPerDayChartProps) {
  return (
    <ChartCard
      title="Rounds per day, by type"
      legend={types.map((type, index) => (
        <Swatch key={type} color={seriesColor(type, index)}>
          {type} <span className="tabular text-foreground">{countByType[type] ?? 0}</span>
        </Swatch>
      ))}
      note="A day with no bar recorded no round. Verify rounds read no code."
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 500, height: 300 }}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} {...AXIS} />
          <YAxis allowDecimals={false} {...AXIS} />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            labelFormatter={dayLabel}
            contentStyle={TOOLTIP_STYLE}
          />
          {types.map((type, index) => (
            <Bar key={type} dataKey={type} stackId="rounds" fill={seriesColor(type, index)} />
          ))}
          {changes?.map((change) => {
            const isSelected = selectedMarkerId === change.id;
            return (
              <ReferenceLine
                key={`${change.id}-${selectedMarkerId}`}
                x={change.at.slice(0, 10)}
                stroke={isSelected ? "var(--foreground)" : "var(--muted-foreground)"}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={isSelected ? undefined : "3 3"}
                className="cursor-pointer"
                onClick={() => onMarkerClick?.(change.id)}
                shape={(props) => (
                  <line
                    {...props}
                    data-testid={`marker-${change.id}`}
                    data-selected={isSelected ? "true" : "false"}
                    aria-selected={isSelected}
                    className="cursor-pointer"
                    onClick={() => onMarkerClick?.(change.id)}
                  />
                )}
                label={{
                  value: change.name,
                  position: "insideTop",
                  fill: isSelected ? "var(--foreground)" : "var(--muted-foreground)",
                  fontSize: 11,
                  cursor: "pointer",
                  onClick: () => onMarkerClick?.(change.id),
                }}
              />
            );
          })}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export interface TokenCompositionChartProps {
  data: TokenDayBucket[];
  totals: { input: number; cacheCreation: number; cacheRead: number };
  changes?: ChangeRow[];
  selectedMarkerId?: string | null;
  onMarkerClick?: (changeId: string) => void;
}

const TOKEN_SERIES = [
  { key: "input", label: "base input", color: "var(--chart-1)" },
  { key: "cacheCreation", label: "cache creation", color: "var(--chart-4)" },
  { key: "cacheRead", label: "cache read", color: "var(--chart-2)" },
] as const;

export function TokenCompositionChart({
  data,
  totals,
  changes,
  selectedMarkerId,
  onMarkerClick,
}: TokenCompositionChartProps) {
  return (
    <ChartCard
      title="Token composition by day"
      legend={TOKEN_SERIES.map((series) => (
        <Swatch key={series.key} color={series.color}>
          {series.label}{" "}
          <span className="tabular text-foreground">{formatTokens(totals[series.key])}</span>
        </Swatch>
      ))}
      note="Input tokens only. A round that recorded no counts contributes nothing rather than a zero."
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 500, height: 300 }}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} {...AXIS} />
          <YAxis tickFormatter={formatTokens} {...AXIS} />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            labelFormatter={dayLabel}
            formatter={tokenValue}
            contentStyle={TOOLTIP_STYLE}
          />
          {TOKEN_SERIES.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              stackId="tokens"
              fill={series.color}
              name={series.label}
            />
          ))}
          {changes?.map((change) => {
            const isSelected = selectedMarkerId === change.id;
            return (
              <ReferenceLine
                key={`${change.id}-${selectedMarkerId}`}
                x={change.at.slice(0, 10)}
                stroke={isSelected ? "var(--foreground)" : "var(--muted-foreground)"}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={isSelected ? undefined : "3 3"}
                className="cursor-pointer"
                onClick={() => onMarkerClick?.(change.id)}
                shape={(props) => (
                  <line
                    {...props}
                    data-testid={`marker-${change.id}`}
                    data-selected={isSelected ? "true" : "false"}
                    aria-selected={isSelected}
                    className="cursor-pointer"
                    onClick={() => onMarkerClick?.(change.id)}
                  />
                )}
                label={{
                  value: change.name,
                  position: "insideTop",
                  fill: isSelected ? "var(--foreground)" : "var(--muted-foreground)",
                  fontSize: 11,
                  cursor: "pointer",
                  onClick: () => onMarkerClick?.(change.id),
                }}
              />
            );
          })}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export interface WallClockScatterChartProps {
  points: ScatterPoint[];
  changes?: ChangeRow[];
  selectedMarkerId?: string | null;
  onMarkerClick?: (changeId: string) => void;
}

export function WallClockScatterChart({
  points,
  changes,
  selectedMarkerId,
  onMarkerClick,
}: WallClockScatterChartProps) {
  const reviewed = points.filter((point) => point.state === "reviewed");
  const unknown = points.filter((point) => point.state === "unknown");

  const minPointsAt = points.length > 0 ? Math.min(...points.map((p) => p.at)) : Infinity;
  const maxPointsAt = points.length > 0 ? Math.max(...points.map((p) => p.at)) : -Infinity;
  const changeStamps = (changes ?? []).map((c) => new Date(c.at).getTime());
  const minChangeAt = changeStamps.length > 0 ? Math.min(...changeStamps) : Infinity;
  const maxChangeAt = changeStamps.length > 0 ? Math.max(...changeStamps) : -Infinity;

  const minAt = Math.min(minPointsAt, minChangeAt);
  const maxAt = Math.max(maxPointsAt, maxChangeAt);
  const domain =
    Number.isFinite(minAt) && Number.isFinite(maxAt) ? [minAt, maxAt] : ["dataMin", "dataMax"];

  return (
    <ChartCard
      title="Wall clock, every round"
      legend={
        <>
          <Swatch color="var(--chart-1)">
            reviewed <span className="tabular text-foreground">{reviewed.length}</span>
          </Swatch>
          <Swatch color="var(--muted-foreground)">
            unknown <span className="tabular text-foreground">{unknown.length}</span>
          </Swatch>
        </>
      }
      note="One dot per round, so the tail stays visible. No p95 is claimed per dot."
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 500, height: 300 }}>
        <ScatterChart margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="at"
            domain={domain}
            tickFormatter={(at: number) => shortDay(new Date(at).toISOString().slice(0, 10))}
            {...AXIS}
          />
          <YAxis
            type="number"
            dataKey="durationMs"
            tickFormatter={formatDuration}
            width={56}
            {...AXIS}
          />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            contentStyle={TOOLTIP_STYLE}
            formatter={durationValue}
            labelFormatter={stampLabel}
          />
          <Scatter name="reviewed" data={reviewed} fill="var(--chart-1)" />
          <Scatter name="unknown" data={unknown} fill="var(--muted-foreground)" />
          {changes?.map((change) => {
            const isSelected = selectedMarkerId === change.id;
            const atMs = new Date(change.at).getTime();
            return (
              <ReferenceLine
                key={`${change.id}-${selectedMarkerId}`}
                x={atMs}
                stroke={isSelected ? "var(--foreground)" : "var(--muted-foreground)"}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={isSelected ? undefined : "3 3"}
                className="cursor-pointer"
                onClick={() => onMarkerClick?.(change.id)}
                shape={(props) => (
                  <line
                    {...props}
                    data-testid={`marker-${change.id}`}
                    data-selected={isSelected ? "true" : "false"}
                    aria-selected={isSelected}
                    className="cursor-pointer"
                    onClick={() => onMarkerClick?.(change.id)}
                  />
                )}
                label={{
                  value: change.name,
                  position: "insideTop",
                  fill: isSelected ? "var(--foreground)" : "var(--muted-foreground)",
                  fontSize: 11,
                  cursor: "pointer",
                  onClick: () => onMarkerClick?.(change.id),
                }}
              />
            );
          })}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

const TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  fontSize: 12,
} as const;

