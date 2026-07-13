import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { InlineOutputPreview } from "./InlineOutputPreview";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("InlineOutputPreview", () => {
  afterEach(() => setLocale("de"));

  it("keeps an image inline and exposes a separately labelled large-view action", () => {
    const html = renderToStaticMarkup(<InlineOutputPreview kind="image" value="flowz-media://localhost/image" label="Generated image" />);
    expect(html).toContain('<img src="flowz-media://localhost/image" alt="Generated image"');
    expect(html).toContain("Groß anzeigen");
    expect(source("./InlineOutputPreview.tsx")).toContain('<div className="inline-output-preview__content">{content(false)}</div>');
    expect(source("./InlineOutputPreview.tsx")).toContain('<button ref={trigger}');
  });

  it("keeps playable video controls inline without nesting them in the open action", () => {
    setLocale("en");
    const html = renderToStaticMarkup(<InlineOutputPreview kind="video" value="flowz-media://localhost/video" label="Generated video" />);
    expect(html).toContain("<video");
    expect(html).toContain(" controls");
    expect(html).toContain('aria-label="Generated video"');
    expect(html).toContain("Open large view");
  });

  it("supports specialized text renderers while retaining the shared preview shell", () => {
    const html = renderToStaticMarkup(<InlineOutputPreview kind="text" value="Result" renderContent={(large) => <p data-size={large ? "large" : "inline"}>Result</p>} />);
    expect(html).toContain('data-size="inline"');
    expect(html).toContain("inline-output-preview--text");
  });

  it("portals a modal with focus trap, Escape close and trigger restoration", () => {
    const component = source("./InlineOutputPreview.tsx");
    expect(component).toContain("createPortal(modal, document.body)");
    expect(component).toContain('role="dialog"');
    expect(component).toContain('aria-modal="true"');
    expect(component).toContain('event.key === "Escape"');
    expect(component).toContain("trapFocus(event, dialog.current)");
    expect(component).toContain("trigger.current?.isConnected");
    expect(component).toContain('t("common.openLarge")');
    expect(component).toContain('t("common.closeLarge")');
  });

  it("is used by provider text and every fal media result surface", () => {
    const provider = source("../nodes/extracted-provider-views.tsx");
    const images = source("../nodes/image/views.tsx");
    const video = source("../nodes/video/views.tsx");
    expect(provider).toContain('<InlineOutputPreview\n          kind="text"');
    expect(images.match(/<InlineOutputPreview/g)).toHaveLength(3);
    expect(video).toContain('<InlineOutputPreview\n          kind="video"');
  });
});
