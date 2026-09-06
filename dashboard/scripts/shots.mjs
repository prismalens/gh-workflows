#!/usr/bin/env node
// Renders every route in fixture mode with headless Chrome, for a fast look at
// what a change did to the pages without a manual click-through. Node built-ins
// only: no new dependency for a script that runs occasionally. Issue #141.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(DASHBOARD_ROOT, "shots");
const CHROME = process.env.CHROME || "google-chrome";
const VIRTUAL_TIME_BUDGET = 8000;
const WINDOW_SIZE = "1440,1400";

const BASE_CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  `--window-size=${WINDOW_SIZE}`,
  `--virtual-time-budget=${VIRTUAL_TIME_BUDGET}`,
];

/** A fixed high port would collide with another shots.mjs run; ask the OS instead. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite never answered at ${url} within ${timeoutMs}ms`);
}

function screenshot(url, file) {
  execFileSync(
    CHROME,
    [...BASE_CHROME_FLAGS, `--screenshot=${file}`, url],
    { stdio: "inherit" },
  );
}

/** Dumps the rendered DOM (after JS runs) so a client-derived link can be scraped. */
function dumpDom(url) {
  return execFileSync(CHROME, [...BASE_CHROME_FLAGS, "--dump-dom", url], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** /prs has no static list of PRs: it groups /api/runs client-side (#141 finding E). */
function findFixturePrPath(origin) {
  const dom = dumpDom(`${origin}/prs`);
  const match = dom.match(/href="(\/prs\/[^"/]+\/[^"/]+\/\d+)"/);
  if (!match) {
    throw new Error("no PR detail link found on the fixture /prs page");
  }
  return match[1];
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });

  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const vite = spawn(join(DASHBOARD_ROOT, "node_modules", ".bin", "vite"), [
    "--port",
    String(port),
    "--strictPort",
    "--host",
    "127.0.0.1",
  ], {
    cwd: DASHBOARD_ROOT,
    env: { ...process.env, VITE_FIXTURES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let viteExited = false;
  vite.on("exit", () => {
    viteExited = true;
  });

  try {
    await waitForServer(`${origin}/`);

    const prPath = findFixturePrPath(origin);
    const routes = [
      ["/", "overview.png"],
      ["/rounds", "rounds.png"],
      ["/rounds/fixture-session-0003", "round-detail.png"],
      ["/repos", "repos.png"],
      ["/failures", "failures.png"],
      ["/prs", "prs.png"],
      [prPath, "pr-detail.png"],
    ];

    for (const [route, file] of routes) {
      if (viteExited) throw new Error("vite exited before every route was captured");
      const target = join(SHOTS_DIR, file);
      screenshot(`${origin}${route}`, target);
      const { size } = statSync(target);
      console.log(`${route} -> ${target} (${size} bytes)`);
    }
  } finally {
    vite.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
