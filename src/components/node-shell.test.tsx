import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NodeShell } from "./NodeShell";

describe("shared node shell", () => {
  it("hosts composed content in the shared surface", () => {
    const html = renderToStaticMarkup(
      <NodeShell selected status="fresh" slots={{ body: <span>Body</span> }} />,
    );
    expect(html).toContain('<span>Body</span>');
  });

  it("defines stable module slots", () => {
    const html = renderToStaticMarkup(
      <NodeShell selected={false} status="stale" slots={{
        ports: <i>ports</i>, header: <header>head</header>, body: <main>body</main>, footer: <footer>foot</footer>, overlays: <aside>overlay</aside>,
      }} />,
    );
    expect(html).toContain('class="flow-node  status-stale"');
    expect(html.indexOf("head")).toBeLessThan(html.indexOf("ports"));
    expect(html.indexOf("ports")).toBeLessThan(html.indexOf("body"));
    expect(html.indexOf("body")).toBeLessThan(html.indexOf("foot"));
  });
});
