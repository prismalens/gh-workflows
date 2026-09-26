import { createRouter } from "@tanstack/react-router";

import { failuresRoute } from "./routes/failures";
import { findingsRoute } from "./routes/findings";
import { fleetRoute } from "./routes/fleet";
import { indexRoute } from "./routes/index";
import { opsRoute } from "./routes/ops";
import { todayRoute } from "./routes/today";
import { prDetailRoute } from "./routes/prDetail";
import { prsRoute } from "./routes/prs";
import { repoDetailRoute } from "./routes/repoDetail";
import { reposRoute } from "./routes/repos";
import { roundDetailRoute } from "./routes/roundDetail";
import { roundsRoute } from "./routes/rounds";
import { rootRoute } from "./routes/root";

export const routeTree = rootRoute.addChildren([
  todayRoute,
  indexRoute,
  fleetRoute,
  opsRoute,
  prsRoute,
  prDetailRoute,
  roundsRoute,
  roundDetailRoute,
  reposRoute,
  repoDetailRoute,
  failuresRoute,
  findingsRoute,
]);

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
