/**
 * Permanent, not dismissible: #111 asks for this on every render of Findings.
 * It stays one line and opens on demand (#209); the full text is always in the
 * DOM. The 32% figure is the measured share of resolved claude[bot] threads
 * closed by github-actions[bot], which is why resolved_by_login is never read
 * as a human signal on its own (see WORKFLOW_ACTOR_LOGINS).
 */
export function FindingsHonestyHeader() {
  return (
    <details
      data-testid="findings-honesty-header"
      className="group rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground open:w-full"
    >
      <summary className="cursor-pointer list-none">
        <span className="font-semibold text-foreground">These findings are what the lane reported about itself</span>
        <span className="ml-2 underline-offset-2 group-open:hidden hover:underline">why that matters</span>
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        <span>
          The lane's verify round grades its own findings: `fixed` and `still_applies` are its own
          verdict, not an independent check.
        </span>
        <span>
          About a third of resolved threads are closed by github-actions[bot], the lane's own
          workflow token, not a person. Every "self-graded" chip on this page covers that case.
        </span>
        <span>
          Bugs the lane never flagged are not counted here at all: this table only ever describes
          what claude[bot] itself reported.
        </span>
      </div>
    </details>
  );
}
