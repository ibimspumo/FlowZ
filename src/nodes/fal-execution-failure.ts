import { appErrorMessage, isSerializedAppError, providerErrorMessage } from "../i18n";
import { classifyRunError, visibleRunErrorMessage } from "../components/run-error-classification";

export type FalExecutionFailure = Readonly<{
  status: "stale" | "error";
  error?: string;
  thrown: string;
}>;

export function falExecutionFailure(reason: unknown, aborted: boolean): FalExecutionFailure {
  const raw = reason instanceof Error ? reason.message : String(reason);
  const preSubmitAbort = reason instanceof DOMException && reason.name === "AbortError";
  if (aborted && preSubmitAbort) return { status: "stale", thrown: appErrorMessage("cancelled") };

  const kind = classifyRunError(raw);
  const typed = isSerializedAppError(raw)
    ? raw
    : kind === "paid-submit-unknown"
      ? appErrorMessage("paid_submit_unknown", visibleRunErrorMessage(raw))
      : aborted
        ? appErrorMessage("cancel_requested", visibleRunErrorMessage(raw))
        : /\b(?:fal\.ai|Provider|HTTP|quota|rate.?limit|429|402|401|400)\b/i.test(raw)
          ? providerErrorMessage("fal.ai", raw)
          : appErrorMessage("validation_failed", raw);
  return { status: "error", error: typed, thrown: typed };
}
