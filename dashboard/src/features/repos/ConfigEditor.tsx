import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { diffLines } from "diff";
import { ExternalLink } from "lucide-react";
import { stringify } from "yaml";

import { ConfigPrError, type ConfigFileResponse, type ConfigPrResponse } from "@/api/client";
import { useApi } from "@/api/provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CONFIG_FIELDS,
  changedKeys,
  EMPTY_CONFIG,
  formatConfigValue,
  readValue,
  validateConfigText,
  writeValue,
  type ConfigField,
} from "./configEdit";

export interface EffectiveEntry {
  value: unknown;
  layer: string | null;
}

const CONTROL =
  "w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

function refusalText(code: string): string {
  switch (code) {
    case "app-cannot-write":
      return "The Assayer App on this repository has no Contents: write permission, so it cannot open the pull request. Commit the file yourself, or accept the permission on the App's installation.";
    case "not-installed":
      return "The Assayer App is not installed on this repository.";
    case "config-changed":
      return "The file changed on GitHub after you opened it. Reload to edit the current version.";
    case "schema-rejected":
      return "The Worker refused the file: it does not pass the review config schema.";
    case "unauthenticated":
      return "Cloudflare Access refused the request. Sign in again, then retry.";
    default:
      return `The pull request was not opened (${code}).`;
  }
}

/** A text control that commits on blur, so a half-typed value never rewrites the file. */
function DraftField({
  field,
  value,
  onCommit,
}: {
  field: ConfigField;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const initial =
    value === undefined
      ? ""
      : field.kind === "list"
        ? (value as unknown[]).map(String).join("\n")
        : field.kind === "yaml"
          ? stringify(value, { version: "1.1" }).trimEnd()
          : String(value);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    setError(null);
    const raw = draft.trim();
    if (raw === "") return onCommit(undefined);
    if (field.kind === "integer") {
      const n = Number(raw);
      if (!Number.isInteger(n)) return setError("a whole number");
      return onCommit(n);
    }
    if (field.kind === "list") {
      return onCommit(
        raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
    }
    if (field.kind === "yaml") {
      try {
        return onCommit(readValue(`v:\n${raw.replace(/^/gm, "  ")}\n`, ["v"]));
      } catch {
        return setError("not YAML");
      }
    }
    return onCommit(raw);
  };

  const multiline = field.kind === "list" || field.kind === "yaml";
  return (
    <div className="flex flex-col gap-1">
      {multiline ? (
        <textarea
          aria-label={field.path.join(".")}
          className={`${CONTROL} min-h-16`}
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          value={draft}
          placeholder={field.kind === "list" ? "one per line; empty inherits" : "YAML; empty inherits"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          aria-label={field.path.join(".")}
          className={CONTROL}
          type={field.kind === "integer" ? "number" : "text"}
          min={field.minimum}
          value={draft}
          placeholder="empty inherits"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      )}
      {error && <span className="text-xs text-[var(--destructive)]">{error}</span>}
    </div>
  );
}

function FieldControl({ field, text, onChange }: { field: ConfigField; text: string; onChange: (next: string) => void }) {
  const value = readValue(text, field.path);
  const set = (next: unknown) => onChange(writeValue(text, field.path, next));
  const label = field.path.join(".");

  if (field.kind === "enum" || field.kind === "boolean") {
    const options = field.kind === "boolean" ? ["true", "false"] : field.options;
    const current = value === undefined ? "" : value === false && field.kind === "enum" ? "off" : String(value);
    return (
      <select
        aria-label={label}
        className={CONTROL}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          set(v === "" ? undefined : field.kind === "boolean" ? v === "true" : v);
        }}
      >
        <option value="">not set (inherits)</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  // Keyed on the value, so an edit in the YAML view resets the draft.
  return <DraftField key={JSON.stringify(value) ?? "unset"} field={field} value={value} onCommit={set} />;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre data-testid="config-diff" className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs">
      {parts.map((p, i) => (
        <span
          key={i}
          className={p.added ? "block bg-green-500/15" : p.removed ? "block bg-red-500/15 line-through opacity-80" : "block text-muted-foreground"}
        >
          {p.value
            .replace(/\n$/, "")
            .split("\n")
            .map((l) => `${p.added ? "+ " : p.removed ? "- " : "  "}${l}`)
            .join("\n")}
        </span>
      ))}
    </pre>
  );
}

function githubEditUrl(file: ConfigFileResponse, text: string): string {
  const base = `https://github.com/${file.repository}`;
  return file.sha
    ? `${base}/edit/${encodeURIComponent(file.default_branch)}/${file.path}`
    : `${base}/new/${encodeURIComponent(file.default_branch)}?${new URLSearchParams({ filename: file.path, value: text })}`;
}

function Editor({
  file,
  effective,
  onClose,
  onReload,
}: {
  file: ConfigFileResponse;
  effective: Record<string, EffectiveEntry> | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const api = useApi();
  const original = file.content ?? "";
  const [text, setText] = useState(file.content ?? EMPTY_CONFIG);
  const [view, setView] = useState<"form" | "yaml">("form");
  const [copied, setCopied] = useState(false);
  const errors = useMemo(() => validateConfigText(text), [text]);
  const changes = useMemo(() => changedKeys(original || EMPTY_CONFIG, text), [original, text]);
  const dirty = text !== original;
  const parses = useMemo(() => readValue(text, ["version"]) !== undefined || text.trim() === "", [text]);

  const pr = useMutation<ConfigPrResponse, ConfigPrError>({
    mutationFn: () =>
      api.openConfigPr({ repository: file.repository, content: text, base_sha: file.sha, summary: changes }),
  });

  if (pr.data) {
    return (
      <Alert data-testid="config-pr-opened">
        <AlertTitle>Pull request #{pr.data.number} is open</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            It changes only {file.path}. Reviews use the new values once it merges, because the lane reads the file at each
            pull request's base ref.
          </span>
          <a href={pr.data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
            {pr.data.url} <ExternalLink className="size-3" />
          </a>
          <Button variant="outline" size="sm" className="self-start" onClick={onClose}>
            Done
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const cannotOpen = !file.can_open_pr || pr.error?.code === "app-cannot-write";

  return (
    <Card data-testid="config-editor">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border">
        <div>
          <CardTitle>
            Edit {file.path} on {file.default_branch}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {file.content === null ? "The repository has no config file yet; this creates it. " : ""}A key left unset inherits
            from the shared layer or the workflow default.
          </p>
        </div>
        <div className="flex gap-1" role="tablist">
          {(["form", "yaml"] as const).map((v) => (
            <Button key={v} role="tab" aria-selected={view === v} size="sm" variant={view === v ? "secondary" : "ghost"} onClick={() => setView(v)}>
              {v === "form" ? "Form" : "YAML"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-4">
        {view === "yaml" ? (
          <textarea
            aria-label="config file"
            className={`${CONTROL} min-h-72`}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        ) : !parses ? (
          <Alert variant="muted">
            <AlertTitle>The file does not parse</AlertTitle>
            <AlertDescription>Fix it in the YAML view; the form edits a file that parses.</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3">
            {CONFIG_FIELDS.map((field) => {
              const eff = field.effectiveKey ? effective?.[field.effectiveKey] : undefined;
              return (
                <div key={field.path.join(".")} data-testid="config-field" className="grid gap-1 sm:grid-cols-[220px_1fr] sm:items-start">
                  <div className="flex flex-col">
                    <span className="font-mono text-xs">{field.path.join(".")}</span>
                    <span className="text-xs text-muted-foreground">{field.description}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <FieldControl field={field} text={text} onChange={setText} />
                    {eff && (
                      <span className="text-xs text-muted-foreground">
                        In effect: <span className="font-mono">{formatConfigValue(eff.value)}</span>{" "}
                        {eff.layer && <Badge variant="outline">{eff.layer}</Badge>}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {errors.length > 0 && (
          <Alert variant="destructive" data-testid="config-errors">
            <AlertTitle>The lane would reject this file</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {errors.map((e) => (
                  <li key={e} className="font-mono text-xs">
                    {e}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {dirty && <DiffView before={original} after={text} />}

        {pr.error && pr.error.code !== "app-cannot-write" && (
          <Alert variant="destructive" data-testid="config-pr-refused">
            <AlertTitle>Not opened</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>{refusalText(pr.error.code)}</span>
              {pr.error.errors.map((e) => (
                <span key={e} className="font-mono text-xs">
                  {e}
                </span>
              ))}
              {pr.error.code === "config-changed" && (
                <Button variant="outline" size="sm" className="self-start" onClick={onReload}>
                  Reload
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {cannotOpen && (
          <Alert variant="muted" data-testid="config-manual">
            <AlertTitle>Commit it yourself</AlertTitle>
            <AlertDescription>{refusalText("app-cannot-write")}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {cannotOpen ? (
            <>
              <Button
                size="sm"
                disabled={!dirty || errors.length > 0}
                onClick={() => {
                  void navigator.clipboard?.writeText(text).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy YAML"}
              </Button>
              <a
                href={githubEditUrl(file, text)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
              >
                Open {file.path} on GitHub <ExternalLink className="size-3" />
              </a>
            </>
          ) : (
            <Button size="sm" disabled={!dirty || errors.length > 0 || pr.isPending} onClick={() => pr.mutate()}>
              {pr.isPending ? "Opening…" : "Open pull request"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">{changes.length} key{changes.length === 1 ? "" : "s"} changed</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Loads the file from the repository's default branch and edits it into a pull request (#78). */
export function ConfigEditor({
  repository,
  effective,
  onClose,
}: {
  repository: string;
  effective: Record<string, EffectiveEntry> | null;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const file = useQuery({
    queryKey: ["config-file", repository],
    queryFn: () => api.fetchConfigFile(repository),
    staleTime: 0,
    retry: false,
  });
  if (file.isPending) return <p className="text-xs text-muted-foreground">Loading {repository}'s config file…</p>;
  if (file.isError) {
    return (
      <Alert variant="destructive" data-testid="config-file-error">
        <AlertTitle>Could not read the config file</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <span>
            {/404|not-installed/.test(file.error.message)
              ? "The Assayer App is not installed on this repository, so the Console cannot read or change its config."
              : file.error.message}
          </span>
          <Button variant="outline" size="sm" className="self-start" onClick={onClose}>
            Back
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Editor
      key={file.data.sha ?? "new"}
      file={file.data}
      effective={effective}
      onClose={onClose}
      onReload={() => void queryClient.invalidateQueries({ queryKey: ["config-file", repository] })}
    />
  );
}
