import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OpsResponse } from "@/api/types";
import { makeFixtureApi } from "@/fixtures/api";
import { recordingApi } from "@/test/recordingApi";
import { renderRoute } from "@/test/renderRoute";

const OPS: OpsResponse = {
  window: { since: "2026-09-19T00:00:00.000Z", days: 7 },
  identity: [
    { repository: "o/legacy", tables: { usage_records: { bearer: 4 } } },
    { repository: "o/modern", tables: { usage_records: { oidc: 31 }, prs: { oidc: 6 } } },
  ],
  credentials: [{ repository: "o/modern", credential_type: "oauth", rounds: 31 }],
  health: [
    { repository: "o/modern", reports: 1, last_received_at: "2026-09-25T00:00:00Z", unaccounted: 2, startup_failures: 1 },
  ],
  worker: { version_id: "0123456789abcdef", version_tag: null, version_timestamp: null, d1_size_bytes: 2072576 },
};

describe("/ops (#179)", () => {
  it("reads only /api/ops and shows ingest identity, credentials, health and the install", async () => {
    const { api, calls } = recordingApi({ ...makeFixtureApi(), fetchOps: async () => OPS });
    renderRoute({ path: "/ops", api });

    expect(await screen.findByTestId("ops-bearer-free")).toHaveTextContent("1 of 2 repositories bearer-free");
    const legacy = screen.getByRole("row", { name: /o\/legacy/ });
    expect(within(legacy).getByText("bearer 4")).toBeInTheDocument();
    expect(within(legacy).getByText("still on the shared token")).toBeInTheDocument();
    const modern = screen.getAllByRole("row", { name: /o\/modern/ })[0];
    expect(within(modern).getByText("OIDC 31")).toBeInTheDocument();

    expect(screen.getByText("subscription OAuth")).toBeInTheDocument();
    expect(screen.getByTestId("ops-worker-version")).toHaveTextContent("01234567");
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();
    expect(new Set(calls)).toEqual(new Set(["fetchOps"]));
  });

  it("says the version is not reported when the binding is absent", async () => {
    const api = {
      ...makeFixtureApi(),
      fetchOps: async () => ({ ...OPS, worker: { ...OPS.worker, version_id: null } }),
    };
    renderRoute({ path: "/ops", api });
    expect(await screen.findByTestId("ops-worker-version")).toHaveTextContent("version not reported");
  });
});
