import { afterEach, describe, expect, it, vi } from "vitest";

import { httpApi } from "./client";

describe("POST /api/config-pr refusals (#237 review)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads an Access 401, 403 or 503 as a lost session, as getJson does", async () => {
    for (const status of [401, 403, 503]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "access_denied" }), { status }));
      await expect(
        httpApi.openConfigPr({ repository: "o/r", content: "version: 1\n", base_sha: null, summary: [] }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
    }
  });

  it("keeps the Worker's own refusal code otherwise", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "config-changed" }), { status: 409 }));
    await expect(
      httpApi.openConfigPr({ repository: "o/r", content: "version: 1\n", base_sha: null, summary: [] }),
    ).rejects.toMatchObject({ code: "config-changed" });
  });
});
