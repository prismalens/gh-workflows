import { createRoute, createRouter, redirect } from "@tanstack/react-router";

import { roundDetailRoute } from "./routes/roundDetail";
import { roundsRoute } from "./routes/rounds";
import { rootRoute } from "./routes/root";

// The overview lands with its own issue. Until then / is the rounds table
// rather than an empty shell promising a page that does not exist.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/rounds", search: { range: "rolling" } });
  },
  component: () => null,
});

const routeTree = rootRoute.addChildren([indexRoute, roundsRoute, roundDetailRoute]);

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
