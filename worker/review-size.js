// Reviewable lines over a pull request's `pulls/{n}/files` JSON, for the App webhook's size
// refusal (#184). A port of the review lane's "Build review manifest" step
// (claude-code-review.yml, #105), which counts over the same JSON. No dependencies, so
// tests/test-webhook-size-drift.py can run it beside the lane's real step on one fixture.

export const WEBHOOK_MAX_FILE_LINES = 2000;

export const DEFAULT_PATH_FILTERS = Object.freeze([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  "dist/**",
  "build/**",
  "vendor/**",
  "**/__snapshots__/**",
  "*.min.js",
  "*.min.css",
  "**/node_modules/**",
]);

const FILE_STATUS_MAP = Object.freeze({
  added: "added",
  removed: "deleted",
  modified: "modified",
  renamed: "renamed",
  changed: "modified",
  copied: "modified",
  unchanged: "modified",
});

// Python's fnmatch on Linux: `*` crosses `/`, `?` is one character, case-sensitive.
function fnmatch(path, pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(path);
}

function matchesPathFilter(path, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return fnmatch(path, pattern);
}

export function reviewableLinesFromFiles(
  files,
  { maxFileLines = WEBHOOK_MAX_FILE_LINES, pathFilters = DEFAULT_PATH_FILTERS } = {}
) {
  let total = 0;
  for (const item of files) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.filename === "string" ? item.filename : "";
    let status = FILE_STATUS_MAP[item.status] ?? "modified";
    const additions = Number(item.additions) || 0;
    const deletions = Number(item.deletions) || 0;
    // GitHub omits `patch` for binary content and for an unchanged rename alike.
    if ((item.patch === undefined || item.patch === null) && status !== "renamed") {
      status = "binary";
    }
    const reviewable =
      status === "added" || status === "modified" || (status === "renamed" && (additions > 0 || deletions > 0));
    const lines = additions + deletions;
    let filtered = pathFilters.some((pattern) => matchesPathFilter(name, pattern));
    if (!filtered && reviewable && maxFileLines > 0 && lines > maxFileLines) {
      filtered = true;
    }
    if (!filtered && reviewable) total += lines;
  }
  return total;
}

