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

const NAV_LINK = "hover:text-foreground";
const NAV_ACTIVE = { className: "text-foreground" };
const NAV_GROUP = "text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/70";

/**
 * Two groups, per the Console IA ruling on #185. /prs, /rounds and /failures
 * leave the nav but keep their routes, so deep links still land. Ops joins
 * Operate once it has a page.
 */
function MainNav() {
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <span className={NAV_GROUP}>Review</span>
      <Link
        to="/"
        search={{ range: DEFAULT_RANGE }}
        className={NAV_LINK}
        activeProps={NAV_ACTIVE}
        activeOptions={{ exact: true }}
      >
        Inbox
      </Link>
      {/* /findings has its own search schema, with no `range`. */}
      <Link to="/findings" search={{}} className={NAV_LINK} activeProps={NAV_ACTIVE}>
        Findings
      </Link>
      <Link to="/repos" search={{ range: DEFAULT_RANGE }} className={NAV_LINK} activeProps={NAV_ACTIVE}>
        Repos
      </Link>
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <span className={NAV_GROUP}>Operate</span>
      <Link to="/fleet" search={{ range: DEFAULT_RANGE }} className={NAV_LINK} activeProps={NAV_ACTIVE}>
        Fleet
      </Link>
    </nav>
  );
}

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
          <MainNav />
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
        Nothing is routed at this address.{" "}
        <Link to="/" search={{ range: DEFAULT_RANGE }} className="underline underline-offset-4">
          Go to the inbox
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
