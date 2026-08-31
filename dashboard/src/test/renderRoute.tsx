import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
  type AnyRoute,
} from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";

import type { TelemetryApi } from "@/api/client";
import { ApiProvider } from "@/api/provider";
import { makeFixtureApi } from "@/fixtures/api";
import { roundDetailRoute } from "@/routes/roundDetail";
import { roundsRoute } from "@/routes/rounds";
import { rootRoute } from "@/routes/root";

export interface RenderRouteOptions {
  path: string;
  api?: TelemetryApi;
}

/**
 * Mounts the real route tree at `path`, so a test exercises the same route
 * definitions, search validation and query hooks the browser does.
 */
export function renderRoute({ path, api = makeFixtureApi() }: RenderRouteOptions): RenderResult {
  const routeTree = rootRoute.addChildren([roundsRoute, roundDetailRoute] as unknown as AnyRoute[]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as never} />
      </ApiProvider>
    </QueryClientProvider>,
  );
}
