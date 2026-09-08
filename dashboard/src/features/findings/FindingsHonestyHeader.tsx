import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Permanent, not dismissible: #111 asks for this on every render of the inbox.
 * The 32% figure is the measured share of resolved claude[bot] threads closed
 * by github-actions[bot] rather than a person, which is why resolved_by_login
 * is never read as a human signal on its own (see WORKFLOW_ACTOR_LOGINS).
 */
export function FindingsHonestyHeader() {
  return (
    <Alert variant="muted" data-testid="findings-honesty-header">
      <AlertTitle>This inbox measures what the lane reported about itself</AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
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
      </AlertDescription>
    </Alert>
  );
}
