import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { closeActiveSelect } from './select-coordinator';

function DialogSurface({ className, onClose, labelledBy, label, children }: {
  className: string; onClose: () => void; labelledBy?: string; label?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeActiveSelect();
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={className} aria-labelledby={labelledBy} aria-label={label} onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{children}</dialog>;
}

export function ModalDialog({ open, ...props }: { open: boolean; className: string; onClose: () => void; labelledBy?: string; label?: string; children: ReactNode }) {
  return open ? createPortal(<DialogSurface {...props} />, document.body) : null;
}
