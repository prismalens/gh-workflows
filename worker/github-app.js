// Mints a per-job installation token for the GitHub App (#184). No D1, and nothing here logs:
// the App key and every token it produces stay inside this module's return value.
import { SignJWT, importPKCS8 } from "jose";

// The runner reads the repository and the pull request and nothing else. Every value is "read",
// and tests/test-app-manifest.py holds these keys to a subset of the App manifest's permissions.
export const INSTALLATION_TOKEN_PERMISSIONS = Object.freeze({"contents": "read", "metadata": "read", "pull_requests": "read", "issues": "read"});
// The poster's token never leaves the Worker: comments and review comments, nothing on contents.
export const POSTER_TOKEN_PERMISSIONS = Object.freeze({"metadata": "read", "pull_requests": "write", "issues": "write"});

const GITHUB_API = "https://api.github.com";

export class MintError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "MintError";
    this.code = code;
    this.status = status;
  }
}

function githubHeaders(jwt) {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "assayer-control-plane",
  };
}

export function createInstallationTokenMinter(env, { fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  return {
    async mint({ owner, repo, permissions = INSTALLATION_TOKEN_PERMISSIONS }) {
      const appId = env?.GITHUB_APP_ID;
      const pem = env?.GITHUB_APP_PRIVATE_KEY;
      if (!appId || !pem) {
        throw new MintError("app-unconfigured");
      }
      // GitHub hands out PKCS#1 keys and importPKCS8 takes PKCS#8 only; worker/README.md has
      // the openssl line that converts one.
      if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
        throw new MintError("app-key-not-pkcs8");
      }

      const key = await importPKCS8(pem, "RS256");
      const iat = Math.floor(now() / 1000) - 60;
      // GitHub caps an app JWT at ten minutes; iat is backdated a minute for clock skew.
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt(iat)
        .setExpirationTime(iat + 600)
        .setIssuer(String(appId))
        .sign(key);

      const installation = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
        method: "GET",
        headers: githubHeaders(jwt),
      });
      if (installation.status === 404) {
        throw new MintError("not-installed", 404);
      }
      if (!installation.ok) {
        throw new MintError("github-error", installation.status);
      }
      const { id: installationId } = await installation.json();

      const minted = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: { ...githubHeaders(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ repositories: [repo], permissions }),
      });
      if (minted.status !== 201) {
        throw new MintError("github-error", minted.status);
      }
      const { token, expires_at } = await minted.json();
      return { token, expires_at, installation_id: installationId };
    },
  };
}
