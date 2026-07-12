import { describe, expect, it } from 'vitest';
import fixture from '../../src-tauri/tests/fixtures/project-v2.json';
import { decodeProjectDocument } from './migrations';

describe('shared Rust/TypeScript project fixture', () => {
  it('decodes a non-empty graph with ordered edges and omitted optional fields', () => {
    const project = decodeProjectDocument(fixture);

    expect(project.graph.nodes).toHaveLength(2);
    expect(project.graph.edges).toEqual([
      expect.objectContaining({ targetPortId: 'text', order: 0 }),
    ]);
    expect(project.graph.groups[0].nodeIds).toEqual(['text-1', 'generate-1']);
    expect('label' in project.graph.nodes[1]).toBe(false);
    expect('description' in project.graph.groups[0]).toBe(false);
  });
});
