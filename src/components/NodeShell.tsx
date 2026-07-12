import type { ReactNode } from "react";
import type { NodeStatus } from "../types";

export type NodeShellSlots = {
  ports?: ReactNode;
  header?: ReactNode;
  body?: ReactNode;
  footer?: ReactNode;
  overlays?: ReactNode;
};

export type NodeShellProps = {
  selected: boolean;
  status: NodeStatus;
  slots?: NodeShellSlots;
};

/**
 * Shared cross-node surface with named composition slots.
 */
export function NodeShell({ selected, status, slots }: NodeShellProps) {
  return (
    <article className={`flow-node ${selected ? "is-selected" : ""} status-${status}`} aria-busy={status === "running" || undefined}>
      <>
          {slots?.ports}
          {slots?.header}
          {slots?.body}
          {slots?.footer}
          {slots?.overlays}
      </>
    </article>
  );
}
