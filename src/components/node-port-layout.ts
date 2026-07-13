import type { CSSProperties } from "react";

export const NODE_PORT_ROW_HEIGHT = 26;
export const NODE_PORT_RAIL_INSET = 5;

/**
 * Keeps the port rail tall enough for both sides. Variant offsets may contain
 * gaps when an older history result is no longer exposed, so their highest
 * row matters rather than only their array length.
 */
export function nodePortRailRowCount(
  inputCount: number,
  outputCount: number,
  variantOffsets: readonly number[] = [],
) {
  const variantRows = variantOffsets.length
    ? Math.max(...variantOffsets) + 1
    : 0;
  return Math.max(1, inputCount, outputCount + variantRows);
}

export function nodePortRailStyle(rowCount: number): CSSProperties {
  return {
    minHeight: `${NODE_PORT_RAIL_INSET * 2 + Math.max(1, rowCount) * NODE_PORT_ROW_HEIGHT}px`,
  };
}

export function nodePortSocketStyle(row: number): CSSProperties {
  return {
    top: `${NODE_PORT_RAIL_INSET + Math.max(0, row) * NODE_PORT_ROW_HEIGHT}px`,
  };
}
