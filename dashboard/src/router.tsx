import { createRouter } from "@tanstack/react-router";

import { indexRoute } from "./routes/index";
import { roundDetailRoute } from "./routes/roundDetail";
import { roundsRoute } from "./routes/rounds";
import { rootRoute } from "./routes/root";

export const routeTree = rootRoute.addChildren([indexRoute, roundsRoute, roundDetailRoute]);

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
