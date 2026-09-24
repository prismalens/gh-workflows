import { cn } from "@/lib/utils";

/** A pill that reads as a control when idle, never as bare bold text (#209). */
function chip(on: boolean): string {
  return cn(
    "inline-flex h-7 items-center rounded-full border px-3 text-xs transition-colors",
    on
      ? "border-foreground bg-foreground font-semibold text-background"
      : "border-border bg-muted/60 text-muted-foreground hover:border-muted-foreground hover:text-foreground",
  );
}

export interface FilterChipsProps {
  label: string;
  options: string[];
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}

/**
 * The filter control on every screen that has one. Chips rather than a select,
 * because at three repositories a dropdown hides the whole option set behind a
 * click. It renders nothing when there is nothing to choose between.
 */
export function FilterChips({ label, options, value, onChange }: FilterChipsProps) {
  if (options.length === 0) return null;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <button type="button" className={chip(value === undefined)} aria-pressed={value === undefined} onClick={() => onChange(undefined)}>
        All
      </button>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={chip(value === option)}
          aria-pressed={value === option}
          onClick={() => onChange(value === option ? undefined : option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
