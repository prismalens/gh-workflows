import { parseToolDetail, type ToolDetail, type ToolGroup } from "@/api/blobs";
import type { RoundAgentRow, RoundRow } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Degraded } from "@/honesty/Degraded";
import { fieldEra } from "@/honesty/fieldEra";
import { formatCount, orDash } from "@/lib/format";
import { Panel } from "./panels";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function groupCalls(groups: ToolGroup[]): number {
  return sum(groups.map((group) => group.calls));
}

function describeGroup(group: ToolGroup): string {
  if (group.pattern === null) return group.path ?? ".";
  return group.path === null ? group.pattern : `${group.pattern} in ${group.path}`;
}

function ToolText({ label, groups }: { label: string; groups: ToolGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <ul className="font-mono text-xs">
        {groups.map((group, i) => (
          <li key={i} className="break-all">
            {describeGroup(group)} ({formatCount(group.calls)})
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Paths and patterns are repository text, so they stay folded, monospace and never linked. */
function ToolPaths({ agent, detail }: { agent: RoundAgentRow; detail: ToolDetail }) {
  if (detail.read.length + detail.grep.length + detail.glob.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Paths and patterns, {agent.subagent_type ?? agent.agent_id}
      </summary>
      <div className="mt-2 flex flex-col gap-2 rounded-md bg-muted/40 p-2">
        <ToolText label="Read" groups={detail.read} />
        <ToolText label="Grep" groups={detail.grep} />
        <ToolText label="Glob" groups={detail.glob} />
      </div>
    </details>
  );
}

export function AgentToolsPanel({ row, agents }: { row: RoundRow; agents: RoundAgentRow[] }) {
  const era = fieldEra(row);
  const parsed = agents.map((agent) => ({
    agent,
    detail: parseToolDetail(agent),
  }));
  const missing = parsed.filter((entry) => entry.detail === null).length;
  const unreadable = parsed.filter((entry) => entry.detail === "unreadable").length;

  return (
    <Panel title="Agent tools">
      {agents.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This round has no per-agent rows, so there are no tool calls to break down.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Read</TableHead>
                <TableHead>Grep</TableHead>
                <TableHead>Glob</TableHead>
                <TableHead>Bash</TableHead>
                <TableHead>Other</TableHead>
                <TableHead>Harness paths</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parsed.map(({ agent, detail }) => {
                const known = detail !== null && detail !== "unreadable" ? detail : null;
                const cell = (count: (d: ToolDetail) => number) =>
                  known === null ? "—" : formatCount(count(known));
                return (
                  <TableRow key={agent.agent_id} data-testid="agent-tools-row">
                    <TableCell className="text-xs">
                      <span className="font-mono">{agent.subagent_type ?? agent.agent_id}</span>
                      {known?.truncated && (
                        <Badge variant="warning" className="ml-2">
                          truncated
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular">{cell((d) => groupCalls(d.read))}</TableCell>
                    <TableCell className="tabular">{cell((d) => groupCalls(d.grep))}</TableCell>
                    <TableCell className="tabular">{cell((d) => groupCalls(d.glob))}</TableCell>
                    <TableCell className="tabular">
                      {cell((d) => sum(d.bash.map((entry) => entry.value)))}
                    </TableCell>
                    <TableCell className="tabular">
                      {cell((d) => sum(d.other.map((entry) => entry.value)))}
                    </TableCell>
                    <TableCell className="tabular">
                      {orDash(agent.harness_paths_count ?? null)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {parsed.map(({ agent, detail }) =>
            detail !== null && detail !== "unreadable" ? (
              <ToolPaths key={agent.agent_id} agent={agent} detail={detail} />
            ) : null,
          )}
        </>
      )}
      {missing > 0 && (
        <Degraded
          what={`Tool detail for ${missing} of ${agents.length} agents`}
          reason={era.reason}
          cause={era.detail}
        />
      )}
      {unreadable > 0 && (
        <Degraded
          what={`Tool detail for ${unreadable} of ${agents.length} agents`}
          reason="unreadable"
          detail="tool_detail held a value that is not the read/grep/glob/bash/other shape."
        />
      )}
    </Panel>
  );
}
