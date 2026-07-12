import {
  Component,
  lazy,
  Suspense,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n";

type Loader<P extends object> = () => Promise<{ default: ComponentType<P> }>;

export function newLazyAttempt<P extends object>(loader: Loader<P>) {
  return lazy(loader);
}

class LazyErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function RecoverableLazy<P extends object>({
  loader,
  componentProps,
  loading,
  className = "panel-loading",
}: {
  loader: Loader<P>;
  componentProps: P;
  loading: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const LazyComponent = useMemo(() => newLazyAttempt(loader), [loader, attempt]);
  const retry = () => setAttempt((value) => value + 1);
  return (
    <LazyErrorBoundary
      key={attempt}
      fallback={
        <div className={`${className} lazy-load-error`} role="alert">
          <span>{t("common.loadFailed")}</span>
          <button type="button" onClick={retry}>
            {t("common.retry")}
          </button>
        </div>
      }
    >
      <Suspense fallback={loading}>
        <LazyComponent {...componentProps} />
      </Suspense>
    </LazyErrorBoundary>
  );
}
