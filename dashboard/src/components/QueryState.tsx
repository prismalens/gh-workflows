import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
 * verifyAccess (worker/index.js) sends one of three codes for an auth-recovery
 * state; this is copy for the three, plus the case (an opaque Access redirect,
 * or a 200 HTML login page) where no code reached the client at all.
 */
const ACCESS_RECOVERY_COPY: Record<string, string> = {
  access_unconfigured: "The Worker has no Access team domain or audience configured.",
  access_keys_unavailable: "The Worker could not fetch Access's signing keys.",
  access_denied: "The Access session is missing, expired, or was rejected.",
};

/**
 * A background fetch can never finish an Access login: it is a redirect chain
 * across an origin this page does not control. Only a real top-level navigation
 * completes it, so this goes back to the page's own URL, which is what a manual
 * reload already did before this control existed. Story: #96.
 */
function signInAgain() {
  window.location.assign(window.location.href);
}

/**
 * Access answers an expired session with an HTML login redirect rather than a
 * 401, so that case needs its own copy and a real recovery control, not a retry.
 */
export function QueryError({
  error,
  title = "Could not load rounds",
}: {
  error: unknown;
  title?: string;
}) {
  if (error instanceof ApiError && error.kind === "unauthenticated") {
    const detail = error.code ? ACCESS_RECOVERY_COPY[error.code] : undefined;
    return (
      <Alert variant="warning">
        <AlertTitle>Cloudflare Access did not let this request through</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>
            {detail ??
              "The Access session could not be verified, and the reason did not reach this page."}
          </span>
          <Button size="sm" onClick={signInAgain}>
            Sign in again
          </Button>
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
