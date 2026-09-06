import { createRouter } from "@tanstack/react-router";

import { failuresRoute } from "./routes/failures";
import { indexRoute } from "./routes/index";
import { prDetailRoute } from "./routes/prDetail";
import { prsRoute } from "./routes/prs";
import { reposRoute } from "./routes/repos";
import { roundDetailRoute } from "./routes/roundDetail";
import { roundsRoute } from "./routes/rounds";
import { rootRoute } from "./routes/root";

export const routeTree = rootRoute.addChildren([
  indexRoute,
  prsRoute,
  prDetailRoute,
  roundsRoute,
  roundDetailRoute,
  reposRoute,
  failuresRoute,
]);

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
