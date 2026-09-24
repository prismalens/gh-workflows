import { cn } from "@/lib/utils";

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

export interface Facet {
  key: string;
  title: string;
  options: FacetOption[];
  selected: string | undefined;
  onSelect: (value: string | undefined) => void;
}

/**
 * Faceted counts beside a list (#209). Each facet counts the rows every other
 * filter leaves, so a click never lands on an empty page without warning; a
 * zero stays listed, dimmed, because what is absent is also an answer.
 */
export function FacetRail({ facets, onClear }: { facets: Facet[]; onClear?: () => void }) {
  return (
    <aside aria-label="Filters" className="flex flex-col gap-3 text-xs">
      <div className="flex items-center justify-between px-1.5">
        <span className="font-semibold">Filters</span>
        {onClear && (
          <button type="button" onClick={onClear} className="text-muted-foreground hover:text-foreground">
            Clear all
          </button>
        )}
      </div>
      {facets.map((facet) => {
        return (
          <div key={facet.key} role="group" aria-label={facet.title} className="flex flex-col gap-0.5">
            <div className="px-1.5 pb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground/80 uppercase">
              {facet.title}
            </div>
            {facet.options.map((opt) => {
              const on = facet.selected === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={on}
                  data-testid={`facet-${facet.key}-${opt.value}`}
                  onClick={() => facet.onSelect(on ? undefined : opt.value)}
                  className={cn(
                    "flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent",
                    opt.count === 0 && !on && "opacity-45",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-3 shrink-0 rounded-[3px] border",
                      on ? "border-foreground bg-foreground" : "border-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate" title={opt.label}>
                    {opt.label}
                  </span>
                  <span className="tabular text-muted-foreground">{opt.count}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
