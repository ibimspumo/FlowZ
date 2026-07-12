import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("recoverable lazy UI contract", () => {
  it("recreates a rejected lazy attempt and exposes a localized retry", () => {
    const source = readFileSync(new URL("./RecoverableLazy.tsx", import.meta.url), "utf8");
    expect(source).toContain("getDerivedStateFromError");
    expect(source).toContain("setAttempt((value) => value + 1)");
    expect(source).toContain('t("common.retry")');
  });

  it("opens and focuses the font search after its deferred module resolves", () => {
    const deferred = readFileSync(new URL("./DeferredFontPicker.tsx", import.meta.url), "utf8");
    const picker = readFileSync(new URL("./FontPicker.tsx", import.meta.url), "utf8");
    expect(deferred).toContain("initiallyOpen:true");
    expect(picker).toContain("queueMicrotask(() => searchRef.current?.focus())");
  });
});
