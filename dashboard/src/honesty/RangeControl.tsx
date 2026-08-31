import { Button } from "@/components/ui/button";
import { RANGE_BUTTON_LABELS, RANGE_KEYS, type RangeKey } from "./range";

export interface RangeControlProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}

/**
 * Four buttons and no date picker. The set is generated from RANGE_KEYS, so a
 * fifth range cannot be added to one screen without changing the ruling (#46).
 */
export function RangeControl({ value, onChange }: RangeControlProps) {
  return (
    <div role="group" aria-label="Range" className="inline-flex rounded-md border border-border">
      {RANGE_KEYS.map((key) => (
        <Button
          key={key}
          size="sm"
          variant={key === value ? "secondary" : "ghost"}
          aria-pressed={key === value}
          className="rounded-none first:rounded-l-md last:rounded-r-md"
          onClick={() => onChange(key)}
        >
          {RANGE_BUTTON_LABELS[key]}
        </Button>
      ))}
    </div>
  );
}
