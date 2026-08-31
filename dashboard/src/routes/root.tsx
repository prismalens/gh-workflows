import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

import { useApi } from "@/api/provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DEFAULT_RANGE } from "@/honesty/range";

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

/**
 * A fixtures build shows 64 invented rounds. Leaving that unmarked is the same
 * dishonesty the rest of this layer exists to prevent, so it is a persistent
 * banner rather than a dev-only console line.
 */
function FixtureBanner() {
  const api = useApi();
  if (!api.fixtures) return null;
  return (
    <div
      data-testid="fixture-banner"
      role="alert"
      className="bg-[var(--warning)] px-5 py-1.5 text-center text-xs font-medium text-black"
    >
      Fixture data. Every round on this page is invented from the schema, not read from D1.
    </div>
  );
}

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/rounds", label: "Rounds" },
  { to: "/failures", label: "Failures" },
  { to: "/repos", label: "Repos" },
] as const;

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <FixtureBanner />
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-4 px-5 py-3">
          <Link
            to="/"
            search={{ range: DEFAULT_RANGE }}
            className="text-sm font-semibold tracking-tight"
          >
            Assayer
          </Link>
          <nav className="flex items-center gap-3 text-sm text-muted-foreground">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                search={{ range: DEFAULT_RANGE }}
                className="hover:text-foreground"
                activeProps={{ className: "text-foreground" }}
                activeOptions={{ exact: item.to === "/" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="ml-auto text-xs text-muted-foreground">
            Review round telemetry, prismalens/gh-workflows
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-5 py-5">
        <Outlet />
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <Alert variant="muted">
      <AlertTitle>No such page</AlertTitle>
      <AlertDescription>
        This build ships the overview, the rounds table, the round detail, the failures page and the repos list. Compare and every PR view each land with their own issue.{" "}
        <Link to="/" search={{ range: DEFAULT_RANGE }} className="underline underline-offset-4">
          Go to the overview
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
