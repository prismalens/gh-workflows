import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, jwtVerify, decodeProtectedHeader } from "jose";
import { createInstallationTokenMinter, MintError, INSTALLATION_TOKEN_PERMISSIONS } from "./github-app.js";

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pkcs8 = await exportPKCS8(privateKey);
const APP_ID = 123456;

function recordingFetch({ installationStatus = 200, tokenStatus = 201 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/installation")) {
      return new Response(JSON.stringify({ id: 42 }), { status: installationStatus });
    }
    if (String(url).includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2026-09-21T13:00:00Z" }), {
        status: tokenStatus,
      });
    }
    return new Response(null, { status: 500 });
  };
  return { calls, fetchImpl };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof MintError, String(err));
    assert.equal(err.code, code);
    return true;
  });
}

describe("GitHub App installation token minter (#184)", () => {
  it("signs an RS256 app JWT, looks up the installation, and returns the minted token", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const minter = createInstallationTokenMinter(
      { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: pkcs8 },
      { fetch: fetchImpl }
    );
    const out = await minter.mint({ owner: "prismalens", repo: "sreforge" });
    assert.deepEqual(out, { token: "ghs_minted", expires_at: "2026-09-21T13:00:00Z", installation_id: 42 });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://api.github.com/repos/prismalens/sreforge/installation");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(headers.get("user-agent"), "assayer-control-plane");
    const jwt = headers.get("authorization").replace(/^Bearer /, "");
    assert.equal(decodeProtectedHeader(jwt).alg, "RS256");
    const { payload } = await jwtVerify(jwt, publicKey, { algorithms: ["RS256"] });
    assert.equal(payload.iss, String(APP_ID));
    assert.equal(payload.exp - payload.iat, 600);
    assert.ok(payload.iat <= Math.floor(Date.now() / 1000) - 59, "iat is backdated 60 s for clock skew");
    assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${jwt}`);
  });

  it("asks for exactly the read-only permission set, scoped to the one repository", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const minter = createInstallationTokenMinter(
      { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: pkcs8 },
      { fetch: fetchImpl }
    );
    await minter.mint({ owner: "o", repo: "r" });
    assert.equal(calls[1].url, "https://api.github.com/app/installations/42/access_tokens");
    assert.equal(calls[1].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[1].init.body), {
      repositories: ["r"],
      permissions: { contents: "read", metadata: "read", pull_requests: "read", issues: "read" },
    });
    assert.ok(Object.isFrozen(INSTALLATION_TOKEN_PERMISSIONS));
  });

  it("a 404 on the installation lookup is not-installed, and no token is requested", async () => {
    const { calls, fetchImpl } = recordingFetch({ installationStatus: 404 });
    const minter = createInstallationTokenMinter(
      { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: pkcs8 },
      { fetch: fetchImpl }
    );
    await rejectsWith(minter.mint({ owner: "o", repo: "r" }), "not-installed");
    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c.url.includes("access_tokens")));
  });

  it("any other failure is github-error carrying the status", async () => {
    for (const [opts, status] of [[{ installationStatus: 500 }, 500], [{ tokenStatus: 422 }, 422]]) {
      const { fetchImpl } = recordingFetch(opts);
      const minter = createInstallationTokenMinter(
        { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: pkcs8 },
        { fetch: fetchImpl }
      );
      await assert.rejects(minter.mint({ owner: "o", repo: "r" }), (err) => {
        assert.equal(err.code, "github-error");
        assert.equal(err.status, status);
        return true;
      });
    }
  });

  it("missing app id or key is app-unconfigured and nothing is fetched", async () => {
    for (const env of [{}, { GITHUB_APP_ID: String(APP_ID) }, { GITHUB_APP_PRIVATE_KEY: pkcs8 }, { GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: pkcs8 }]) {
      const { calls, fetchImpl } = recordingFetch();
      const minter = createInstallationTokenMinter(env, { fetch: fetchImpl });
      await rejectsWith(minter.mint({ owner: "o", repo: "r" }), "app-unconfigured");
      assert.equal(calls.length, 0);
    }
  });

  it("a PKCS#1 key is app-key-not-pkcs8 and nothing is fetched", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n";
    const minter = createInstallationTokenMinter(
      { GITHUB_APP_ID: String(APP_ID), GITHUB_APP_PRIVATE_KEY: pkcs1 },
      { fetch: fetchImpl }
    );
    await rejectsWith(minter.mint({ owner: "o", repo: "r" }), "app-key-not-pkcs8");
    assert.equal(calls.length, 0);
  });
});
