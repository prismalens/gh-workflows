import { createContext, useContext, type ReactNode } from "react";

import { makeFixtureApi } from "@/fixtures/api";
import { httpApi, type TelemetryApi } from "./client";

/**
 * VITE_FIXTURES=1 swaps the Worker for the in-memory fixture table. The condition
 * folds to a literal at build time but the module is retained anyway, because
 * fixtures/rounds.ts calls makeRounds() at module scope; no live path reaches it
 * in a normal build. A fixtures build says so on screen, see FixtureBanner.
 */
export const defaultApi: TelemetryApi =
  import.meta.env.VITE_FIXTURES === "1" ? makeFixtureApi() : httpApi;

const ApiContext = createContext<TelemetryApi>(defaultApi);

export function ApiProvider({ api, children }: { api: TelemetryApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): TelemetryApi {
  return useContext(ApiContext);
}
