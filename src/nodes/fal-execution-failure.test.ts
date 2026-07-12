import { describe, expect, it } from "vitest";
import { localizeErrorMessage, setLocale } from "../i18n";
import { falExecutionFailure } from "./fal-execution-failure";

describe("fal execution failure state", () => {
  it("keeps only a proven pre-submit abort stale", () => {
    const failure = falExecutionFailure(new DOMException("Aborted", "AbortError"), true);
    expect(failure.status).toBe("stale");
    expect(failure.error).toBeUndefined();
  });

  it("surfaces unknown and late cancellation instead of downgrading them to stale", () => {
    setLocale("en");
    const unknown = falExecutionFailure(new Error("FLOWZ_SUBMIT_UNKNOWN: accepted response lost"), true);
    expect(unknown.status).toBe("error");
    expect(localizeErrorMessage(unknown.error)).toMatch(/may already have been accepted/i);
    const requested = falExecutionFailure(new Error("Provider accepted cancellation request"), true);
    expect(localizeErrorMessage(requested.error)).toMatch(/Cancellation requested/i);
    setLocale("de");
  });

  it("preserves actionable validation and redacted provider detail", () => {
    setLocale("en");
    expect(localizeErrorMessage(falExecutionFailure(new Error("A prompt is required."), false).error)).toContain("A prompt is required.");
    expect(localizeErrorMessage(falExecutionFailure(new Error("fal.ai HTTP 429 https://private.example"), false).error)).toBe("fal.ai: fal.ai HTTP 429 [URL]");
    setLocale("de");
  });
});
