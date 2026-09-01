import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { humanizeKey, parsePerModelUsage, parseRawResult, parseSubagentStats } from "@/api/blobs";
import type { RoundRow } from "@/api/types";
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
import { Approximate, Degraded } from "@/honesty/Degraded";
import {
  CACHE_CREATION_WEIGHT,
  CACHE_READ_WEIGHT,
  LIST_RATE_EQUIVALENT,
} from "@/honesty/thresholds";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatUsd,
  orDash,
  shortSha,
} from "@/lib/format";

export function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular truncate">{children}</dd>
    </div>
  );
}

/** subagent_stats keys are not ours to pin, so only the _ms suffix is read. */
function formatCounter(key: string, value: number): string {
  return /_ms$/.test(key) ? formatDuration(value) : formatCount(value);
}

export function ResolutionPanel({ row }: { row: RoundRow }) {
  const raw = parseRawResult(row);
  return (
    <Panel
      title="Resolution"
      aside={
        raw?.is_error ? (
          <Badge variant="destructive">the action reported an error</Badge>
        ) : raw ? (
          <Badge variant="outline">reviewed</Badge>
        ) : null
      }
    >
      <Facts>
        <Fact label="Repository">{row.repository}</Fact>
        <Fact label="Recorded">
          <Timestamp iso={row.recorded_at} />
        </Fact>
        <Fact label="Round type">{orDash(row.round_type)}</Fact>
        <Fact label="Model">{orDash(row.model)}</Fact>
        <Fact label="Head SHA">
          <span className="font-mono">{shortSha(row.head_sha)}</span>
        </Fact>
        <Fact label="Run attempt">
          {row.run_attempt !== null && row.run_attempt > 1 ? (
            <Badge variant="warning">attempt {row.run_attempt}</Badge>
          ) : (
            orDash(row.run_attempt)
          )}
        </Fact>
        <Fact label="Reviewed diff">
          {row.changed_files === null && row.diff_lines === null
            ? "—"
            : `${orDash(row.changed_files)} files, ${orDash(row.diff_lines)} lines`}
        </Fact>
        <Fact label="Result subtype">{orDash(raw?.subtype ?? null)}</Fact>
      </Facts>

      <div className="flex flex-wrap gap-3 text-sm">
        {row.pr_url && (
          <a
            href={row.pr_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            Pull request #{row.pr_number} <ExternalLink className="size-3.5" />
          </a>
        )}
        {row.run_url && (
          <a
            href={row.run_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            Actions run <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      <Degraded
        what="Review verdict"
        reason="unbuilt"
        detail="A record proves a round ran and finished; whether it approved, requested changes or found nothing is not sent to telemetry. Two states are derivable today: reviewed, and unknown."
      />
    </Panel>
  );
}

export function TimingPanel({ row }: { row: RoundRow }) {
  const wall = row.duration_ms;
  const api = row.duration_api_ms;
  // duration_api_ms is summed across concurrent subagents, so on a fan-out round it
  // exceeds wall clock. Subtracting then yields a negative "overhead" that reads as a
  // broken clock; the ratio is the honest reading of the same two columns.
  const parallel = wall !== null && api !== null && api > wall;
  const overhead = wall !== null && api !== null && !parallel ? wall - api : null;
  const parallelism = parallel && wall! > 0 ? api! / wall! : null;

  return (
    <Panel title="Timing">
      <Facts>
        <Fact label="Wall clock">{orDash(wall, formatDuration)}</Fact>
        <Fact label="API time, summed">{orDash(api, formatDuration)}</Fact>
        {parallel ? (
          <Fact label="Parallelism">
            {parallelism === null ? "—" : `${parallelism.toFixed(2)}x`}
          </Fact>
        ) : (
          <Fact label="Outside the API">{orDash(overhead, formatDuration)}</Fact>
        )}
        <Fact label="Turns">{orDash(row.num_turns)}</Fact>
      </Facts>
      <p className="text-xs text-muted-foreground">
        {parallel
          ? "API seconds are summed across concurrent agents, so exceeding wall clock means the fan-out ran in parallel, not that the round was slow. Time spent outside the API cannot be separated out on such a round."
          : "Time outside the API is checkout, tool calls and posting, derived as wall clock minus API time. It is not measured separately."}
      </p>
    </Panel>
  );
}

export function FanOutPanel({ row }: { row: RoundRow }) {
  const stats = parseSubagentStats(row);
  const perModel = parsePerModelUsage(row);

  return (
    <Panel
      title="Fan-out"
      aside={<Approximate why="lifecycle counts and a per-model split; no per-agent data exists" />}
    >
      {stats === null ? (
        <Degraded
          what="Subagent lifecycle counts"
          reason="lane-did-not-send"
          detail="A single-agent round has no fan-out to report, and a lane predating the field sends nothing."
        />
      ) : stats.unreadable ? (
        <Degraded
          what="Subagent lifecycle counts"
          reason="lane-did-not-send"
          detail="The column held a value with no countable fields in it."
        />
      ) : (
        <>
          <Facts>
            {stats.lifecycle.map((entry) => (
              <Fact key={entry.key} label={humanizeKey(entry.key)}>
                {formatCounter(entry.key, entry.value)}
              </Fact>
            ))}
          </Facts>
          {stats.groups.map((group) => (
            <div key={group.key}>
              <p className="mb-1 text-xs text-muted-foreground">{humanizeKey(group.key)}</p>
              <Facts>
                {group.entries.map((entry) => (
                  <Fact key={entry.key} label={humanizeKey(entry.key)}>
                    {formatCounter(entry.key, entry.value)}
                  </Fact>
                ))}
              </Facts>
            </div>
          ))}
        </>
      )}

      {perModel ? (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Per-model split</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Cache read</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(perModel).map(([model, usage]) => (
                <TableRow key={model}>
                  <TableCell className="font-mono text-xs">{model}</TableCell>
                  <TableCell className="tabular">
                    {orDash(usage.inputTokens ?? null, formatTokens)}
                  </TableCell>
                  <TableCell className="tabular">
                    {orDash(usage.outputTokens ?? null, formatTokens)}
                  </TableCell>
                  <TableCell className="tabular">
                    {orDash(usage.cacheReadInputTokens ?? null, formatTokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Degraded what="Per-model split" reason="lane-did-not-send" />
      )}

      <Degraded
        what="Per-agent breakdown"
        reason="unbuilt"
        detail="Which agent spent what would have to come from parsing the execution file's sidechains. Gap M9 in #46."
      />
    </Panel>
  );
}

export function TokensPanel({ row }: { row: RoundRow }) {
  const input = row.input_tokens ?? 0;
  const read = row.cache_read_input_tokens ?? 0;
  const create = row.cache_creation_input_tokens ?? 0;
  const total = input + read + create;
  const billed = input + CACHE_CREATION_WEIGHT * create + CACHE_READ_WEIGHT * read;
  const anyTokens =
    row.input_tokens !== null ||
    row.cache_read_input_tokens !== null ||
    row.cache_creation_input_tokens !== null;
  // The same rule tokenSums applies across rounds, applied within one: a count
  // missing and summed as zero reads as "this round used no cache".
  const allCounts =
    row.input_tokens !== null &&
    row.cache_read_input_tokens !== null &&
    row.cache_creation_input_tokens !== null;

  return (
    <Panel title="Tokens">
      {anyTokens ? (
        <>
          <Facts>
            <Fact label="Input">{orDash(row.input_tokens, formatTokens)}</Fact>
            <Fact label="Output">{orDash(row.output_tokens, formatTokens)}</Fact>
            <Fact label="Cache read">{orDash(row.cache_read_input_tokens, formatTokens)}</Fact>
            <Fact label="Cache creation">
              {orDash(row.cache_creation_input_tokens, formatTokens)}
            </Fact>
            <Fact label="Cache hit rate">
              {allCounts && total > 0 ? formatPercent(read / total) : "—"}
            </Fact>
            <Fact label="Caching multiplier">
              {allCounts && billed > 0 ? `${(total / billed).toFixed(2)}x` : "—"}
            </Fact>
            <Fact label={LIST_RATE_EQUIVALENT}>{orDash(row.total_cost_usd, formatUsd)}</Fact>
          </Facts>
          <p className="text-xs text-muted-foreground">
            The multiplier is uncached-equivalent input over billed-equivalent input. It is
            arithmetic over the recorded counts, not a saving: no counterfactual run exists to
            compare against.
          </p>
        </>
      ) : (
        <Degraded
          what="Token counts"
          reason="lane-did-not-send"
          detail="The action's result object carried no modelUsage for this round."
        />
      )}
    </Panel>
  );
}

export function DenialsPanel({ row }: { row: RoundRow }) {
  const raw = parseRawResult(row);
  const tools = raw?.denial_tools ?? null;
  const count = row.permission_denials;

  return (
    <Panel title="Permission denials">
      <Facts>
        <Fact label="Denials this round">
          {count === null ? (
            "—"
          ) : count > 0 ? (
            <span className="text-[var(--warning)]">{formatCount(count)}</span>
          ) : (
            formatCount(count)
          )}
        </Fact>
      </Facts>

      {tools === null ? (
        <Degraded
          what="Which tools were denied"
          reason="lane-did-not-send"
          detail="denial_tools is written into raw_result by the extraction step; a round from an older lane has no such key."
        />
      ) : tools.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tool was denied. The lane asked for nothing it did not have.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Denials</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.map((entry) => (
              <TableRow key={entry.tool}>
                <TableCell className="font-mono text-xs">{entry.tool}</TableCell>
                <TableCell className="tabular">{formatCount(entry.count)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">
        Tool names only. The extraction step drops tool_input so no attacker-influenced text ever
        reaches the store.
      </p>
    </Panel>
  );
}

export function RawRecordPanel({ row }: { row: RoundRow }) {
  const raw = parseRawResult(row);
  return (
    <Panel title="Raw record">
      {raw ? (
        <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : (
        <Degraded
          what="Raw result object"
          reason="lane-did-not-send"
          detail="raw_result is nullable and this round stored none."
        />
      )}
      <p className="text-xs text-muted-foreground">
        Every model-authored string is nulled before storage; what remains is the enum-shaped
        fields plus the denial tool counts.
      </p>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Stored columns for this round
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(row, null, 2)}
        </pre>
      </details>
    </Panel>
  );
}
