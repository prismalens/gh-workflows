import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/api/client";

export function LoadingRows({
  rows = 6,
  label = "Loading rounds",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * Access answers an expired session with an HTML login redirect rather than a
 * 401, so that case needs its own copy: a reload is the fix, not a retry.
 */
export function QueryError({
  error,
  title = "Could not load rounds",
}: {
  error: unknown;
  title?: string;
}) {
  if (error instanceof ApiError && error.kind === "unauthenticated") {
    return (
      <Alert variant="warning">
        <AlertTitle>Cloudflare Access did not let this request through</AlertTitle>
        <AlertDescription>
          Reload the page to sign in again. The read routes verify the Access JWT in the Worker,
          so an expired session fails here rather than at the edge.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  );
}
