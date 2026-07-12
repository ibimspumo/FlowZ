import { describe, expect, it } from "vitest";
import { classifyRunError, visibleRunErrorMessage } from "./run-error-classification";

describe("paid run error classification", () => {
  it("never downgrades an unknown paid submit merely because it says aborted", () => {
    const message =
      "FLOWZ_SUBMIT_UNKNOWN: Der Streaming-Ausgang ist unbekannt: Der Lauf wurde abgebrochen. FlowZ sendet nicht automatisch erneut.";
    expect(classifyRunError(message)).toBe("paid-submit-unknown");
    expect(visibleRunErrorMessage(message)).not.toContain("FLOWZ_SUBMIT_UNKNOWN");
  });

  it("still treats a proven ordinary cancellation as harmless", () => {
    expect(classifyRunError("Bildgenerierung vor dem Submit abgebrochen.")).toBe("cancelled");
    expect(classifyRunError("Providerfehler")).toBe("error");
  });

  it("recognizes durable video and image-tool unknown manifests without relying on translated cancellation words", () => {
    expect(classifyRunError("Der Submit-Ausgang ist unbekannt: transport lost. FlowZ sendet diesen Run nicht automatisch erneut.")).toBe("paid-submit-unknown");
    expect(classifyRunError("No safe fal request ID; do not submit automatically again.")).toBe("paid-submit-unknown");
  });
});
