import type { RoundRow } from "@/api/types";
import { Timestamp } from "@/components/Timestamp";
import { Badge } from "@/components/ui/badge";
import { Degraded } from "@/honesty/Degraded";
import { fieldEra } from "@/honesty/fieldEra";
import { orDash } from "@/lib/format";
import { Fact, Facts, Panel } from "./panels";

/** The eight classes the lane's classifier emits (claude-code-review.yml, #174). */
export const FAILURE_CLASS_COPY: Record<string, { label: string; line: string }> = {
  "account-limit": {
    label: "account limit",
    line: "The subscription hit its session or weekly limit; nothing runs until it resets.",
  },
  "rate-limited": {
    label: "rate limited",
    line: "The API throttled the request; a later run usually goes through.",
  },
  "auth-failed": {
    label: "authentication failed",
    line: "The credential was expired, revoked or disabled; someone has to replace it.",
  },
  billing: {
    label: "billing",
    line: "The account is out of credit or over its spend limit.",
  },
  "model-unavailable": {
    label: "model unavailable",
    line: "The requested model is unknown or not available to this organization.",
  },
  "request-too-large": {
    label: "request too large",
    line: "The prompt exceeded the model's context window.",
  },
  "api-unavailable": {
    label: "API unavailable",
    line: "The API was overloaded, erroring or unreachable; waiting usually helps.",
  },
  "api-error": {
    label: "other API error",
    line: "The API failed in a way the classifier does not recognise.",
  },
};

export function hasFailure(row: RoundRow): boolean {
  return (
    row.verdict_kind === "api-error" ||
    row.job_conclusion === "failure" ||
    (row.failure_class !== null && row.failure_class !== undefined)
  );
}

/** Rendered only on a failed round: a succeeded round with no class is not a gap. */
export function FailurePanel({ row }: { row: RoundRow }) {
  if (!hasFailure(row)) return null;
  const cls = row.failure_class ?? null;
  const copy = cls === null ? null : FAILURE_CLASS_COPY[cls];
  const era = fieldEra(row);

  return (
    <Panel title="Failure" aside={<Badge variant="destructive">round failed</Badge>}>
      {cls === null ? (
        <Degraded what="Failure class" reason={era.reason} cause={era.detail} />
      ) : (
        <>
          <Facts>
            <Fact label="Class">{copy?.label ?? cls}</Fact>
            <Fact label="Waiting helps">
              {row.failure_retryable === 1 ? "yes" : row.failure_retryable === 0 ? "no" : "—"}
            </Fact>
            <Fact label="Resets">
              {row.failure_reset_at ? (
                <Timestamp iso={row.failure_reset_at} />
              ) : (
                "no reset time recorded"
              )}
            </Fact>
            <Fact label="API status">{orDash(row.api_error_status ?? null, String)}</Fact>
          </Facts>
          {copy && <p className="text-xs text-muted-foreground">{copy.line}</p>}
        </>
      )}
    </Panel>
  );
}
