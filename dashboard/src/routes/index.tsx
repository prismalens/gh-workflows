import { createRoute, redirect } from "@tanstack/react-router";

import { DEFAULT_RANGE } from "@/honesty/range";
import { rootRoute } from "./root";

// The overview lands with its own issue. Until then / is the rounds table rather
// than an empty shell promising a page that does not exist.
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/rounds", search: { range: DEFAULT_RANGE } });
  },
  component: () => null,
});
