import type { CanvasTemplate } from './types';

/** Resolves omitted template orders per target port, never across the graph. */
export function materializedTemplateEdgeOrders(template: CanvasTemplate): number[] {
  const occupied = new Map<string, Set<number>>();
  return template.edges.map((edge) => {
    const key = `${edge.target}\0${edge.targetPort}`;
    const used = occupied.get(key) ?? new Set<number>();
    let order = edge.order;
    if (order === undefined) {
      order = 0;
      while (used.has(order)) order += 1;
    }
    used.add(order);
    occupied.set(key, used);
    return order;
  });
}
