import type { TelemetryApi } from "@/api/client";

/**
 * Wraps an api so a test can read which methods a page called, in order. The
 * fetch set per route is the API wall's client half (#185).
 */
export function recordingApi(base: TelemetryApi): { api: TelemetryApi; calls: string[] } {
  const calls: string[] = [];
  const api = new Proxy(base, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { api, calls };
}
