import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-4 px-5 py-3">
          <Link to="/rounds" className="text-sm font-semibold tracking-tight">
            Assayer
          </Link>
          <nav className="flex items-center gap-3 text-sm text-muted-foreground">
            <Link
              to="/rounds"
              className="hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
            >
              Rounds
            </Link>
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
        This build ships the rounds table and the round detail. The overview, repos, failures and
        compare pages each land with their own issue.{" "}
        <Link to="/rounds" className="underline underline-offset-4">
          Go to rounds
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
