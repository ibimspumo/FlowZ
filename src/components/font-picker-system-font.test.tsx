import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { FontPicker } from "./FontPicker";

describe("FontPicker system font fallback", () => {
  it("renders an unknown system family without crashing the lazy picker", () => {
    setLocale("de");
    const html = renderToStaticMarkup(<FontPicker label="Schriftfamilie" value="Georgia" onChange={vi.fn()} />);
    expect(html).toContain("Georgia");
    expect(html).toContain("Systemschrift");
    expect(html).toContain('aria-haspopup="listbox"');
  });
});
