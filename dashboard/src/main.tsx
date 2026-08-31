import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { ApiProvider, defaultApi } from "./api/provider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { createAppRouter } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const router = createAppRouter();

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ApiProvider api={defaultApi}>
          <RouterProvider router={router} />
        </ApiProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
