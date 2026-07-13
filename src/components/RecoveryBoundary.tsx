import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n, type Locale } from "../i18n";

export type RecoveryScope = "app" | "workspace" | "node";

const copy = {
  de: {
    app: {
      eyebrow: "FlowZ · Wiederherstellung",
      title: "Die Oberfläche konnte nicht vollständig geladen werden.",
      body: "Deine gespeicherten Projekte bleiben erhalten. Versuche die Oberfläche erneut zu öffnen oder lade FlowZ neu.",
    },
    workspace: {
      eyebrow: "Arbeitsfläche angehalten",
      title: "Dieser Flow konnte gerade nicht dargestellt werden.",
      body: "Die App bleibt geöffnet. Versuche nur die Arbeitsfläche neu aufzubauen; falls der Fehler bleibt, lade FlowZ neu.",
    },
    node: {
      eyebrow: "Node angehalten",
      title: "Diese Node konnte nicht dargestellt werden.",
      body: "Der restliche Flow funktioniert weiter. Du kannst die Darstellung dieser Node erneut versuchen.",
    },
    retry: "Erneut versuchen",
    reload: "FlowZ neu laden",
  },
  en: {
    app: {
      eyebrow: "FlowZ · Recovery",
      title: "The interface could not be loaded completely.",
      body: "Your saved projects remain available. Try opening the interface again or reload FlowZ.",
    },
    workspace: {
      eyebrow: "Workspace paused",
      title: "This flow could not be displayed.",
      body: "The app remains open. Try rebuilding only the workspace; if the problem persists, reload FlowZ.",
    },
    node: {
      eyebrow: "Node paused",
      title: "This node could not be displayed.",
      body: "The rest of the flow keeps working. You can retry rendering this node.",
    },
    retry: "Try again",
    reload: "Reload FlowZ",
  },
} as const;

export function RecoveryFallback({
  locale,
  scope,
  label,
  onRetry,
  onReload,
}: {
  locale: Locale;
  scope: RecoveryScope;
  label?: string;
  onRetry: () => void;
  onReload?: () => void;
}) {
  const text = copy[locale];
  const scopeCopy = text[scope];
  return (
    <div className={`recovery-fallback recovery-fallback--${scope}`} role="alert">
      <div className="recovery-fallback__mark" aria-hidden="true">!</div>
      <div className="recovery-fallback__content">
        <span className="recovery-fallback__eyebrow">{scopeCopy.eyebrow}</span>
        <strong>{label ? `${label}: ${scopeCopy.title}` : scopeCopy.title}</strong>
        <p>{scopeCopy.body}</p>
        <div className="recovery-fallback__actions">
          <button type="button" className="primary" onClick={onRetry}>{text.retry}</button>
          {onReload ? <button type="button" className="secondary" onClick={onReload}>{text.reload}</button> : null}
        </div>
      </div>
    </div>
  );
}

type BoundaryProps = {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
  resetKey?: string;
  scope: RecoveryScope;
};

class RecoveryBoundaryCore extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[FlowZ ${this.props.scope} recovery]`, error, info.componentStack);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("flowz-ui-error", {
        detail: { scope: this.props.scope, message: error.message },
      }));
    }
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  private retry = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

export function RecoveryBoundary({
  children,
  scope,
  label,
  resetKey,
}: {
  children: ReactNode;
  scope: RecoveryScope;
  label?: string;
  resetKey?: string;
}) {
  const { locale } = useI18n();
  const reload = scope === "node" || typeof window === "undefined"
    ? undefined
    : () => window.location.reload();
  return (
    <RecoveryBoundaryCore
      scope={scope}
      resetKey={resetKey}
      fallback={(retry) => (
        <RecoveryFallback
          locale={locale}
          scope={scope}
          label={label}
          onRetry={retry}
          onReload={reload}
        />
      )}
    >
      {children}
    </RecoveryBoundaryCore>
  );
}
