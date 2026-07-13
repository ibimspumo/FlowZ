import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppNodeHost } from "./AppNodeHost";
import { RecoveryFallback } from "./RecoveryBoundary";
import { historyPreviewText } from "./NodeResultHistory";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("UI recovery contracts", () => {
  it("treats a missing canonical graph node as a benign removal frame", () => {
    const markup = renderToStaticMarkup(createElement(AppNodeHost, {
      module: { id: "test-module" } as never,
      node: undefined,
      selected: false,
      status: "idle",
    }));
    expect(markup).toBe("");
    expect(source("./ModuleNodeComponent.tsx")).toContain("if (!graphNode) return null");
  });

  it("renders understandable localized recovery actions", () => {
    const retry = vi.fn();
    const reload = vi.fn();
    const german = renderToStaticMarkup(<RecoveryFallback locale="de" scope="app" onRetry={retry} onReload={reload} />);
    const english = renderToStaticMarkup(<RecoveryFallback locale="en" scope="node" label="Image" onRetry={retry} />);
    expect(german).toContain('role="alert"');
    expect(german).toContain("Erneut versuchen");
    expect(german).toContain("FlowZ neu laden");
    expect(english).toContain("Image:");
    expect(english).toContain("Try again");
  });

  it("isolates failures at app, workspace and node scope", () => {
    const boundary = source("./RecoveryBoundary.tsx");
    expect(boundary).toContain("getDerivedStateFromError");
    expect(boundary).toContain("componentDidCatch");
    expect(source("../main.tsx")).toContain('<RecoveryBoundary scope="app">');
    expect(source("../App.tsx")).toContain('<RecoveryBoundary scope="workspace"');
    expect(source("./ModuleNodeComponent.tsx")).toContain('<RecoveryBoundary scope="node"');
  });
});

describe("history overlay accessibility contract", () => {
  it("portals the modal outside the transformed canvas and restores focus", () => {
    const history = source("./NodeResultHistory.tsx");
    expect(history).toContain("createPortal(content, document.body)");
    expect(history).toContain('role="dialog" aria-modal="true"');
    expect(history).toContain("trapDialogFocus(event, panel.current)");
    expect(history).toContain("trapDialogFocus(event, lightbox.current)");
    expect(history).toContain("previousFocus?.isConnected");
    expect(history).toContain('event.key === "Escape"');
    expect(history).toContain("setLarge(item)");
    expect(history).not.toContain('kind==="text")toggle(item.id)');
  });

  it("keeps the complete generated text in the expanded viewer", () => {
    const value = "x".repeat(150_000);
    expect(historyPreviewText(value, true)).toBe(value);
    expect(historyPreviewText(value, false)).toHaveLength(2_001);
  });
});

describe("node loading-state contract", () => {
  it("uses one footer status and cancel affordances instead of duplicate spinners", () => {
    const provider = source("../nodes/extracted-provider-views.tsx");
    const native = source("../nodes/extracted-node-views.tsx");
    expect(provider).not.toContain("<LoaderCircle");
    expect(provider).toContain("<Square size={14}");
    expect(native).not.toContain('<LoaderCircle className="spin" size={15} />');
    expect(native).toContain('<Square size={15} />');
  });
});
