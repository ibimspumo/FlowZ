export type RunErrorKind = "paid-submit-unknown" | "cancelled" | "error";

const SUBMIT_UNKNOWN_CODE = "FLOWZ_SUBMIT_UNKNOWN:";

export function classifyRunError(message: string): RunErrorKind {
  if (message.trimStart().startsWith(SUBMIT_UNKNOWN_CODE)
    || /(?:Submit-Ausgang|submit outcome).{0,40}(?:unbekannt|unknown)|(?:sendet|submit).{0,40}nicht automatisch erneut|no safe .*request.?id/i.test(message))
    return "paid-submit-unknown";
  return /abgebrochen/i.test(message) ? "cancelled" : "error";
}

export function visibleRunErrorMessage(message: string): string {
  return message.trimStart().startsWith(SUBMIT_UNKNOWN_CODE)
    ? message.trimStart().slice(SUBMIT_UNKNOWN_CODE.length).trimStart()
    : message;
}
