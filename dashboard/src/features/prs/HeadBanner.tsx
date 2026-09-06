import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { HeadStatus } from "./headStatus";

export function HeadBanner({
  status,
}: {
  status: HeadStatus;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!status.copyableHint || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(status.copyableHint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Set copied only on resolved write (finding 3943781302).
    }
  };

  const isGreen = status.headRead;
  const isWarning = status.state === "did-not-run";
  const isBlue = status.state === "threads-only";

  const borderColor = isGreen
    ? "border-[#3AA36844] bg-[#3AA36812]"
    : isWarning
      ? "border-[#AD873444] bg-[#AD873412]"
      : isBlue
        ? "border-[#4E7FE044] bg-[#4E7FE012]"
        : "border-[#DB4A7844] bg-[#DB4A7812]";

  const iconColor = isGreen
    ? "#3AA368"
    : isWarning
      ? "#AD8734"
      : isBlue
        ? "#4E7FE0"
        : "#DB4A78";

  return (
    <div
      data-testid="head-banner"
      className={`flex flex-col gap-2 rounded-lg border p-3 sm:p-4 ${borderColor}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke={iconColor} strokeWidth="2" className="shrink-0">
            {isGreen ? (
              <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <circle cx="8" cy="8" r="6" />
            )}
          </svg>
          <span className="text-sm font-medium text-foreground">{status.sentence}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          liveness derived from latest round
        </span>
      </div>

      {status.rawVerdict && (
        <div
          data-testid="raw-verdict"
          className="rounded border border-border/40 bg-background/50 px-3 py-1.5 font-mono text-xs text-foreground/90"
        >
          {status.rawVerdict}
        </div>
      )}

      {status.copyableHint && (
        <div
          data-testid="unblock-hint"
          className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground"
        >
          <span>Unblock hint:</span>
          <code className="rounded bg-background/70 px-2 py-0.5 font-mono text-xs text-foreground select-all border border-border/50">
            {status.copyableHint}
          </code>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={handleCopy}
            aria-label="Copy unblock hint"
          >
            {copied ? (
              <>
                <Check className="size-3 text-emerald-500" /> Copied
              </>
            ) : (
              <>
                <Copy className="size-3" /> Copy
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
