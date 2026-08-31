import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";

import type { TelemetryApi } from "@/api/client";
import { ApiProvider } from "@/api/provider";
import { makeFixtureApi } from "@/fixtures/api";
import { routeTree } from "@/router";

export interface RenderRouteOptions {
  path: string;
  api?: TelemetryApi;
}

/**
 * Mounts the real route tree at `path`, so a test exercises the same route
 * definitions, search validation and query hooks the browser does.
 */
export function renderRoute({ path, api = makeFixtureApi() }: RenderRouteOptions): RenderResult {
  // The app's own tree, index redirect included, so a test cannot pass against a
  // route graph the browser never sees.
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
        <RouterProvider router={router} />
      </ApiProvider>
    </QueryClientProvider>,
  );
}
