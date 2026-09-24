import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import {
  FILTER_KEY_HINTS,
  parseQuery,
  type FilterKey,
  type FilterToken,
} from "@/features/filters/grammar";

export interface FilterBarProps {
  tokens: FilterToken[];
  text: string;
  /** The keys this list understands; a token for another key is left as text. */
  keys: FilterKey[];
  onChange: (next: { tokens: FilterToken[]; text: string }) => void;
  placeholder?: string;
}

/**
 * Removable tokens plus a free-text box (#209). Typing `repo:acme` and a space
 * turns it into a token; Backspace on an empty box removes the last one; `/`
 * anywhere on the page focuses the box unless the palette claims it first.
 */
export function FilterBar({ tokens, text, keys, onChange, placeholder }: FilterBarProps) {
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(text), [text]);

  function commit(value: string) {
    const parsed = parseQuery(value);
    const accepted = parsed.tokens.filter((t) => keys.includes(t.key));
    const rejected = parsed.tokens.filter((t) => !keys.includes(t.key)).map((t) => `${t.key}:${t.value}`);
    const merged = [...tokens.filter((t) => !accepted.some((a) => a.key === t.key)), ...accepted];
    const nextText = [...rejected, parsed.text].filter(Boolean).join(" ");
    setDraft(nextText);
    onChange({ tokens: merged, text: nextText });
  }

  function remove(key: FilterKey) {
    onChange({ tokens: tokens.filter((t) => t.key !== key), text });
  }

  const hint = keys.map((k) => `${k}:`).join("  ");

  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1 focus-within:ring-2 focus-within:ring-[var(--ring)]"
      onClick={() => inputRef.current?.focus()}
    >
      {tokens.map((t) => (
        <span
          key={t.key}
          data-testid={`filter-token-${t.key}`}
          className="inline-flex items-center gap-1 rounded border border-border bg-card py-0.5 pr-0.5 pl-2 text-xs"
          title={FILTER_KEY_HINTS[t.key]}
        >
          <span className="text-muted-foreground">{t.key}:</span>
          {t.value}
          <button
            type="button"
            aria-label={`Remove ${t.key} filter`}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              remove(t.key);
            }}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        data-filter-input
        type="search"
        aria-label="Filter"
        value={draft}
        placeholder={tokens.length ? "" : (placeholder ?? `Type to filter, or ${hint}`)}
        onChange={(e) => {
          const value = e.target.value;
          if (/\S+:\S+\s$/.test(value)) commit(value);
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(draft);
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          if (e.key === "Backspace" && draft === "" && tokens.length > 0) {
            remove(tokens[tokens.length - 1]!.key);
          }
        }}
        onBlur={() => {
          if (draft !== text) commit(draft);
        }}
        className="h-7 min-w-[180px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
