import { createRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { useHealthReportsQuery } from "@/api/queries";
import { LoadingRows, QueryError } from "@/components/QueryState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WeeklyHealth } from "@/features/repos/WeeklyHealth";
import { DEFAULT_RANGE } from "@/honesty/range";
import { rootRoute } from "./root";

export const repoDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$owner/$repo",
  component: RepoDetailPage,
});

// The Console IA (#185) gives this page five tabs; the others land with F4.
const TABS = [{ key: "health", label: "Weekly health" }] as const;

function RepoDetailPage() {
  const { owner, repo } = repoDetailRoute.useParams();
  const repository = `${owner}/${repo}`;
  const health = useHealthReportsQuery(repository);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="sm" variant="ghost">
          <Link to="/repos" search={{ range: DEFAULT_RANGE }}>
            <ArrowLeft className="size-4" /> Repos
          </Link>
        </Button>
        <h1 className="font-mono text-base font-semibold tracking-tight">{repository}</h1>
        <Link
          to="/rounds"
          search={{ range: DEFAULT_RANGE, repository }}
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Rounds
        </Link>
      </div>

      <div role="tablist" className="flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => (
          <span
            key={tab.key}
            role="tab"
            aria-selected="true"
            className="border-b-2 border-primary px-3 py-2 text-xs font-semibold text-foreground"
          >
            {tab.label}
          </span>
        ))}
      </div>

      <div role="tabpanel">
        {health.isPending ? (
          <LoadingRows rows={4} label="Loading health reports" />
        ) : health.isError ? (
          <QueryError error={health.error} title="Could not load health reports" />
        ) : health.data.rows.length === 0 ? (
          <Alert variant="muted">
            <AlertTitle>No health report has arrived for {repository}</AlertTitle>
            <AlertDescription>
              A report arrives once a week from the repository's telemetry-health workflow. None
              is stored for this name.
            </AlertDescription>
          </Alert>
        ) : (
          <WeeklyHealth rows={health.data.rows} truncated={health.data.next_cursor != null} />
        )}
      </div>
    </div>
  );
}
