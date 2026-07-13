import { Expand, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { DeferredMarkdown } from "./DeferredMarkdown";
import "./InlineOutputPreview.css";

export type InlineOutputKind = "text" | "image" | "video";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, video[controls], [tabindex]:not([tabindex="-1"])';

function trapFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || !dialog) return;
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.hidden && item.getAttribute("aria-hidden") !== "true");
  if (!items.length) { event.preventDefault(); dialog.focus(); return; }
  const active = document.activeElement;
  const outside = !(active instanceof Node) || !dialog.contains(active);
  const first = items[0], last = items[items.length - 1];
  if (outside || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function InlineOutputPreview({
  kind,
  value,
  label,
  poster,
  renderContent,
}: {
  kind: InlineOutputKind;
  value: string;
  label?: string;
  poster?: string;
  renderContent?: (large: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const accessibleLabel = label ?? t("common.openLarge");

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => (closeButton.current ?? dialog.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (trigger.current?.isConnected) queueMicrotask(() => trigger.current?.focus());
    };
  }, [open]);

  const content = (large: boolean) => {
    if (renderContent) return renderContent(large);
    if (kind === "image") return <img src={value} alt={label ?? ""} />;
    if (kind === "video") return <video src={value} poster={poster} controls playsInline preload="metadata" aria-label={accessibleLabel} />;
    return <DeferredMarkdown value={value} />;
  };

  const modal = open ? (
    <div className="inline-output-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section
        ref={dialog}
        className={`inline-output-modal inline-output-modal--${kind}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
          trapFocus(event, dialog.current);
        }}
      >
        <header>
          <strong id={titleId}>{t("common.openLarge")}</strong>
          <button ref={closeButton} type="button" className="icon-button" onClick={() => setOpen(false)} aria-label={t("common.closeLarge")}>
            <X size={16} />
          </button>
        </header>
        <div className="inline-output-modal__content">{content(true)}</div>
      </section>
    </div>
  ) : null;

  return (
    <div className={`inline-output-preview inline-output-preview--${kind}`}>
      <div className="inline-output-preview__content">{content(false)}</div>
      <button ref={trigger} type="button" className="secondary inline-output-preview__open" onClick={() => setOpen(true)}>
        <Expand size={12} />
        <span>{t("common.openLarge")}</span>
      </button>
      {modal && typeof document !== "undefined" ? createPortal(modal, document.body) : modal}
    </div>
  );
}
