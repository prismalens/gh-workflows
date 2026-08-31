import { Component, type ErrorInfo, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The honesty rules enforce themselves by throwing, which without this renders a
 * white screen and reads as an outage. A caught violation has to say what it was
 * and stay on screen, because the whole point is that it gets noticed (#46).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("dashboard crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <AlertTitle>The dashboard stopped rendering</AlertTitle>
          <AlertDescription>
            <p className="mb-2">{error.message}</p>
            <p>
              A message about a headline tile or a suppressed statistic is one of the honesty rules
              refusing to render something. Reload to retry; the rule is in
              <code className="mx-1 font-mono">dashboard/src/honesty/</code>.
            </p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
}
