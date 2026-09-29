import { useCallback, useState } from "react";
import { createRootRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { useApi } from "@/api/provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CommandPalette, usePaletteHotkey } from "@/features/search/CommandPalette";
import { RangeControl } from "@/honesty/RangeControl";
import { DEFAULT_RANGE, isRangeKey, type RangeKey } from "@/honesty/range";

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
 * Home, then the two groups of the Console IA ruling on #185 (#209). /prs,
 * /rounds and /failures leave the nav but keep their routes, so deep links
 * still land. Ops joins Operate once it has a page.
 */
function MainNav() {
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <Link to="/" className={NAV_LINK} activeProps={NAV_ACTIVE} activeOptions={{ exact: true }}>
        Home
      </Link>
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <span className={NAV_GROUP}>Review</span>
      <Link to="/inbox" search={{ range: DEFAULT_RANGE }} className={NAV_LINK} activeProps={NAV_ACTIVE}>
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

/** One range for every page whose address carries one; pages without it hide the control. */
function HeaderRange() {
  const location = useRouterState({ select: (s) => s.location });
  const navigate = useNavigate();
  const search = location.search as Record<string, unknown>;
  const range = search.range;
  if (typeof range !== "string" || !isRangeKey(range)) return null;
  return (
    <RangeControl
      value={range}
      onChange={(next: RangeKey) =>
        void navigate({ to: location.pathname, search: { ...search, range: next } } as never)
      }
    />
  );
}

function RootLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const open = useCallback(() => setPaletteOpen(true), []);
  usePaletteHotkey(open);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <FixtureBanner />
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-4 px-5 py-3">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            Assayer
          </Link>
          <MainNav />
          <button
            type="button"
            onClick={open}
            data-testid="open-search"
            className="ml-auto flex h-8 w-[min(420px,40vw)] items-center gap-2 rounded-md border border-border bg-muted/60 px-3 text-xs text-muted-foreground hover:border-muted-foreground"
          >
            <Search className="size-3.5" aria-hidden />
            Search or jump to a repo, PR, finding, sha or session
            <kbd className="ml-auto rounded border border-border px-1.5 font-mono text-[10.5px]">/</kbd>
          </button>
          <HeaderRange />
        </div>
      </header>
      <main className="mx-auto max-w-[1600px] px-5 py-5">
        <Outlet />
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function NotFound() {
  return (
    <Alert variant="muted">
      <AlertTitle>No such page</AlertTitle>
      <AlertDescription>
        Nothing is routed at this address.{" "}
        <Link to="/" className="underline underline-offset-4">
          Go to Home
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
