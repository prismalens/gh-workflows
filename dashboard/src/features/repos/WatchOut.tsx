import { Link } from "@tanstack/react-router";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { linkableRange, type RangeKey } from "@/honesty/range";
import { formatTimestampCompact } from "@/lib/format";
import type { MalformedConfigWatch, QuietRepoWatch } from "./repos";

export interface WatchOutProps {
  malformed: MalformedConfigWatch[];
  quiet: QuietRepoWatch[];
  range: RangeKey;
  windowLabel: string;
}

/**
 * Two repository lists worth a human's attention, between the count tiles and
 * the table (#141). Never hides: an empty card still says so, so its absence
 * can never be mistaken for a missing feature.
 */
export function WatchOut({ malformed, quiet, range, windowLabel }: WatchOutProps) {
  const linkRange = linkableRange(range);
  const isEmpty = malformed.length === 0 && quiet.length === 0;

  return (
    <Card data-testid="watch-out">
      <CardHeader className="border-b border-border">
        <CardTitle>Watch out</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {isEmpty ? (
          <p className="text-muted-foreground">Nothing to watch in this window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {malformed.map((item) => (
              <li key={`malformed-${item.repository}-${item.layer}`}>
                <Link
                  to="/failures"
                  search={{ range: linkRange, repository: item.repository }}
                  className="underline-offset-4 hover:underline"
                >
                  {item.repository}
                </Link>
                {`: ${item.layer} layer malformed, lane on workflow defaults`}
              </li>
            ))}
            {quiet.map((item) => (
              <li key={`quiet-${item.repository}`}>
                <Link
                  to="/rounds"
                  search={{ range: "all", repository: item.repository }}
                  className="underline-offset-4 hover:underline"
                >
                  {item.repository}
                </Link>
                {`: no round in ${windowLabel}, last round ${formatTimestampCompact(item.lastRoundAt)}`}
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">
          A quiet repository and a dead lane look the same here, until{" "}
          <Link
            to="/failures"
            search={{ range: linkRange }}
            className="underline-offset-4 hover:underline"
          >
            lane events
          </Link>{" "}
          say otherwise.
        </p>
      </CardContent>
    </Card>
  );
}
