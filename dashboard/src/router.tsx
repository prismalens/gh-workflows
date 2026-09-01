import { createRouter } from "@tanstack/react-router";

import { compareRoute } from "./routes/compare";
import { failuresRoute } from "./routes/failures";
import { indexRoute } from "./routes/index";
import { reposRoute } from "./routes/repos";
import { roundDetailRoute } from "./routes/roundDetail";
import { roundsRoute } from "./routes/rounds";
import { rootRoute } from "./routes/root";

export const routeTree = rootRoute.addChildren([
  indexRoute,
  roundsRoute,
  roundDetailRoute,
  reposRoute,
  failuresRoute,
  compareRoute,
]);

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
