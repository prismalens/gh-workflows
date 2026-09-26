"""The GitHub App manifest asks for the minimum, and the minted token asks for less (#184).

The App's private key is a Worker secret anyone who can deploy the Worker can read, so the
permission set is pinned here: contents and metadata read, pull_requests and issues write,
nothing else. The installation token the lease mints must be read-only and a subset of it.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "worker" / "github-app.manifest.json"
MINTER = ROOT / "worker" / "github-app.js"

EXPECTED_PERMISSIONS = {
    "contents": "read",
    "metadata": "read",
    "pull_requests": "write",
    "issues": "write",
}


def main():
    fails = []
    manifest = json.loads(MANIFEST.read_text())

    perms = manifest.get("default_permissions")
    if perms != EXPECTED_PERMISSIONS:
        fails.append(f"default_permissions is {perms}, expected exactly {EXPECTED_PERMISSIONS}")
    if manifest.get("default_events") != ["pull_request"]:
        fails.append(f"default_events is {manifest.get('default_events')}, expected ['pull_request']")
    hook = manifest.get("hook_attributes") or {}
    if not str(hook.get("url", "")).endswith("/webhook/github"):
        fails.append(f"hook_attributes.url {hook.get('url')!r} must end with /webhook/github")
    if hook.get("active") is not True:
        fails.append("hook_attributes.active must be true")
    if manifest.get("public") is not False:
        fails.append("public must be false: one App per install, no shared tenancy")
    if not str(manifest.get("url", "")).startswith("https://"):
        fails.append(f"url {manifest.get('url')!r} must start with https://")

    m = re.search(r"INSTALLATION_TOKEN_PERMISSIONS\s*=\s*Object\.freeze\((\{.*?\})\)", MINTER.read_text(), re.S)
    if not m:
        fails.append("INSTALLATION_TOKEN_PERMISSIONS = Object.freeze({...}) not found in worker/github-app.js")
    else:
        token_perms = json.loads(m.group(1))
        writes = {k: v for k, v in token_perms.items() if v != "read"}
        if writes:
            fails.append(f"the installation token must be read-only; it asks for {writes}")
        extra = set(token_perms) - set(EXPECTED_PERMISSIONS)
        if extra:
            fails.append(f"the installation token asks for {sorted(extra)}, which the App manifest does not grant")
        print(f"  installation token permissions: {token_perms}")

    m = re.search(r"POSTER_TOKEN_PERMISSIONS\s*=\s*Object\.freeze\((\{.*?\})\)", MINTER.read_text(), re.S)
    if not m:
        fails.append("POSTER_TOKEN_PERMISSIONS = Object.freeze({...}) not found in worker/github-app.js")
    else:
        poster_perms = json.loads(m.group(1))
        # The poster writes comments and review comments (#184); it never gets contents.
        if "contents" in poster_perms:
            fails.append("the poster token must not ask for contents")
        beyond = {k: v for k, v in poster_perms.items() if EXPECTED_PERMISSIONS.get(k) not in (v, "write")}
        if beyond:
            fails.append(f"the poster token asks for {beyond}, beyond what the App manifest grants")
        print(f"  poster token permissions: {poster_perms}")

    print(f"  manifest default_permissions: {perms}")
    if fails:
        for f in fails:
            print(f"FAIL {f}")
        sys.exit(1)
    print("ok: the App manifest and the installation token hold the pinned permission set")


if __name__ == "__main__":
    main()
