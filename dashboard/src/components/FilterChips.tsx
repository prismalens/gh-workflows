import { Button } from "@/components/ui/button";

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
      <Button
        size="sm"
        variant={value === undefined ? "secondary" : "ghost"}
        aria-pressed={value === undefined}
        onClick={() => onChange(undefined)}
      >
        All
      </Button>
      {options.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={value === option ? "secondary" : "ghost"}
          aria-pressed={value === option}
          onClick={() => onChange(value === option ? undefined : option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}
