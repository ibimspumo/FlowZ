import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../domain/project';
import { InvalidLegacyProjectError, InvalidProjectDocumentError, migrateProject, migrateV1ToV2, UnsupportedSchemaVersionError } from '../domain/migrations';
import { isRuntimeValue, isValueType, listType, listValue, scalarType } from '../domain/values';
import { acceptsRuntimeValue, areValueTypesCompatible, hasInputCapacity } from './compatibility';
import { canonicalStringify, createNodeFingerprintPayload, sha256Fingerprint } from './fingerprint';
import { findCycle, validateGraph, wouldCreateCycle } from './graph';
import type { NodePort } from './node-module';
import { createExecutionPlan, CycleError, GraphValidationError } from './planner';
import { defineNodeRegistry } from './registry';
import { textInputModule } from '../nodes/core';

const node = (id: string): GraphNode => ({
  id,
  moduleId: 'test.node',
  moduleVersion: 1,
  position: { x: 0, y: 0 },
  config: {},
  updatePolicy: 'manual',
});

const edge = (sourceNodeId: string, targetNodeId: string, order = 0): GraphEdge => ({
  id: `${sourceNodeId}-${targetNodeId}`,
  sourceNodeId,
  sourcePortId: 'out',
  targetNodeId,
  targetPortId: 'in',
  order,
});

describe('execution planner', () => {
  it('plans a diamond in parallel stages and waits at the join', () => {
    const graph = {
      nodes: ['a', 'b', 'c', 'd'].map(node),
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd', 1)],
    };

    expect(createExecutionPlan(graph)).toEqual({
      orderedNodeIds: ['a', 'b', 'c', 'd'],
      parallelStages: [['a'], ['b', 'c'], ['d']],
    });
    expect(createExecutionPlan(graph, { targetNodeIds: ['d'] }).orderedNodeIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('detects and rejects cycles', () => {
    const graph = { nodes: ['a', 'b', 'c'].map(node), edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')] };
    expect(findCycle(graph)).toEqual(['a', 'b', 'c', 'a']);
    expect(() => createExecutionPlan(graph)).toThrow(CycleError);
    expect(wouldCreateCycle(
      { nodes: graph.nodes, edges: [edge('a', 'b'), edge('b', 'c')] },
      edge('c', 'a'),
    )).toBe(true);
  });

  it('reports malformed graphs and unknown planning targets', () => {
    const graph = { nodes: [node('a')], edges: [edge('missing', 'a')] };
    expect(validateGraph(graph).map((issue) => issue.code)).toContain('dangling-source');
    expect(() => createExecutionPlan(graph)).toThrow(GraphValidationError);
    expect(() => createExecutionPlan({ nodes: [node('a')], edges: [] }, { targetNodeIds: ['missing'] })).toThrow(GraphValidationError);
  });
});

describe('value compatibility', () => {
  it('keeps cardinality-many separate from a list value', () => {
    const manyText: NodePort = { id: 'in', label: 'Text', valueType: scalarType('text'), cardinality: 'many' };
    const textList: NodePort = { id: 'in', label: 'Liste', valueType: listType('text') };
    const firstEdge = [edge('a', 'b')];

    expect(areValueTypesCompatible(scalarType('text'), manyText.valueType)).toBe(true);
    expect(areValueTypesCompatible(listType('text'), manyText.valueType)).toBe(false);
    expect(areValueTypesCompatible(listType('text'), textList.valueType)).toBe(true);
    expect(hasInputCapacity(manyText, firstEdge)).toBe(true);
    expect(hasInputCapacity(textList, firstEdge)).toBe(false);
    expect(acceptsRuntimeValue(manyText, {
      kind: 'list', itemType: 'text', items: [{ type: 'text', value: 'one' }],
    })).toBe(false);
    expect(isRuntimeValue({ kind: 'list', itemType: 'text', items: [{ type: 'image', assetId: 'a' }] })).toBe(false);
    expect(isRuntimeValue({ kind: 'list', itemType: 'bogus', items: [] })).toBe(false);
    expect(isRuntimeValue({ kind: 'list', itemType: 'text', items: 'not-an-array' })).toBe(false);
    expect(isRuntimeValue({ kind: 'unknown' })).toBe(false);
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'json', value: { nested: [1, true, null] } } })).toBe(true);
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'json', value: { missing: undefined } } })).toBe(false);
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'json', value: new Date() } })).toBe(false);
    expect(isValueType({ kind: 'scalar', scalar: 'bogus' })).toBe(false);
    expect(isValueType({ kind: 'list', item: 'image' })).toBe(true);
    expect(() => listValue('text', [{ type: 'image', assetId: 'a' }])).toThrow(TypeError);
  });

  it('rejects malformed runtime media and non-JSON scalar extras', () => {
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'image', assetId: '' } })).toBe(false);
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'webpage', url: '', title: 4 } })).toBe(false);
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'text', value: 'ok', extra: new Date() } })).toBe(false);
    expect(isRuntimeValue({ kind: 'scalar', value: { type: 'json', value: new Map() } })).toBe(false);
  });
});

describe('canonical fingerprints', () => {
  it('is stable across object key order while preserving ordered many-inputs', async () => {
    expect(canonicalStringify({ b: 2, a: { y: true, x: 'x' } }))
      .toBe(canonicalStringify({ a: { x: 'x', y: true }, b: 2 }));

    const bindings = [{ edgeId: 'e1', sourceNodeId: 'source', sourcePortId: 'out', targetNodeId: 'target',
      targetPortId: 'in', order: 0, activeResultId: 'r1', outputId: 'output',
      contentIdentity: { kind: 'inlineHash' as const, inlineHash: 'content' } }];
    const first = createNodeFingerprintPayload({
      moduleId: 'core.test', moduleVersion: 1, config: { b: 2, a: 1 }, provider: 'openrouter', model: 'model/a', bindings,
    });
    const same = createNodeFingerprintPayload({
      moduleId: 'core.test', moduleVersion: 1, config: { a: 1, b: 2 }, provider: 'openrouter', model: 'model/a', bindings,
    });
    expect(await sha256Fingerprint(first)).toBe(await sha256Fingerprint(same));
    for (const changed of [
      { ...bindings[0], sourcePortId: 'other' }, { ...bindings[0], targetPortId: 'other' },
      { ...bindings[0], order: 1 }, { ...bindings[0], activeResultId: 'r2' },
      { ...bindings[0], outputId: 'other' },
      { ...bindings[0], contentIdentity: { kind: 'inlineHash' as const, inlineHash: 'changed' } },
      { ...bindings[0], contentIdentity: { kind: 'blobHash' as const, blobHash: 'blob' } },
    ]) {
      const payload = createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: { a: 1, b: 2 },
        provider: 'openrouter', model: 'model/a', bindings: [changed] });
      expect(await sha256Fingerprint(payload)).not.toBe(await sha256Fingerprint(first));
    }
    const otherModel = createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: { a: 1, b: 2 },
      provider: 'openrouter', model: 'model/b', bindings });
    expect(await sha256Fingerprint(otherModel)).not.toBe(await sha256Fingerprint(first));
    const otherProvider = createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: { a: 1, b: 2 },
      provider: 'direct', model: 'model/a', bindings });
    expect(await sha256Fingerprint(otherProvider)).not.toBe(await sha256Fingerprint(first));

    const list = { ...bindings[0], contentIdentity: {
      kind: 'orderedItemHashes' as const, itemHashes: ['first', 'second'] as [string, ...string[]],
    } };
    const reordered = { ...list, contentIdentity: {
      kind: 'orderedItemHashes' as const, itemHashes: ['second', 'first'] as [string, ...string[]],
    } };
    expect(await sha256Fingerprint(createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: {}, bindings: [list] })))
      .not.toBe(await sha256Fingerprint(createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: {}, bindings: [reordered] })));

    const specialBindings = ['a', 'A', 'ä', '😀'].map((targetPortId, index) => ({ ...bindings[0], edgeId: `e${index}`, targetPortId }));
    const sorted = createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: {}, bindings: specialBindings });
    expect((sorted.bindings as Array<{ targetPortId: string }>).map((binding) => binding.targetPortId)).toEqual(['A', 'a', 'ä', '😀']);
    expect(() => createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: {}, bindings: [
      { ...bindings[0], contentIdentity: { kind: 'inlineHash', inlineHash: '' } },
    ] })).toThrow(/must not be empty/);
    expect(() => createNodeFingerprintPayload({ moduleId: 'core.test', moduleVersion: 1, config: {}, bindings: [
      { ...bindings[0], contentIdentity: { kind: 'orderedItemHashes', itemHashes: [] } as never },
    ] })).toThrow(/must not be empty/);
  });
});

describe('node registry', () => {
  it('validates module ids, versions, ports and defaults while retaining literal ids', () => {
    expect(defineNodeRegistry(textInputModule).byId['core.text-input']).toBe(textInputModule);
    expect(() => defineNodeRegistry(textInputModule, textInputModule)).toThrow(/Duplicate node module/);
    const mutate = (changes: Record<string, unknown>) => ({ ...textInputModule, ...changes });
    expect(() => defineNodeRegistry(mutate({ id: ' ' }))).toThrow(/must not be empty/);
    expect(() => defineNodeRegistry(mutate({ version: 0 }))).toThrow(/Invalid version/);
    expect(() => defineNodeRegistry(mutate({ View: undefined }))).toThrow(/requires a View/);
    expect(() => defineNodeRegistry(mutate({ Icon: null }))).toThrow(/requires an Icon/);
    expect(() => defineNodeRegistry(mutate({ inputs: [
      { id: 'same', label: 'A', valueType: scalarType('text') }, { id: 'same', label: 'B', valueType: scalarType('text') },
    ] }))).toThrow(/Duplicate input/);
    expect(() => defineNodeRegistry(mutate({ outputs: [
      { id: 'same', label: 'A', valueType: scalarType('text') }, { id: 'same', label: 'B', valueType: scalarType('text') },
    ] }))).toThrow(/Duplicate output/);
    expect(() => defineNodeRegistry(mutate({ defaultConfig: { text: 1 } }))).toThrow(/Invalid default/);
  });

  it('requires the full NodeModule contract at compile time', () => {
    if (false) {
      // @ts-expect-error label is mandatory in the complete NodeModule contract
      defineNodeRegistry({ ...textInputModule, label: undefined });
      // @ts-expect-error execute is mandatory in the complete NodeModule contract
      defineNodeRegistry({ ...textInputModule, execute: undefined });
      // @ts-expect-error category is mandatory in the complete NodeModule contract
      defineNodeRegistry({ ...textInputModule, category: undefined });
    }
    expect(defineNodeRegistry(textInputModule).get(textInputModule.id)).toBe(textInputModule);
  });
});

describe('v1 migration', () => {
  it('creates a slim v2 document and a lossless import package for text, images, history and costs', () => {
    const legacy = {
      schemaVersion: 1 as const,
      id: 'old',
      name: 'Old project',
      nodes: [
        { id: 'text', position: { x: 10, y: 20 }, data: {
          kind: 'textInput', label: 'Brief', value: 'hello', status: 'fresh', cost: 0.004,
          history: [{ value: 'runtime result' }], error: 'old error',
        } },
        { id: 'image', data: {
          kind: 'imageInput', value: 'data:image/png;base64,abc', fileName: 'reference.png', status: 'fresh',
        } },
        { id: 'ai', data: {
          kind: 'textGeneration', prompt: 'short', model: 'model/a', value: 'generated runtime output',
          history: [{ id: 'old-result', value: 'older', createdAt: '2026-01-01', cost: 0.5 }], cost: 1.25,
        } },
      ],
      edges: [{ id: 'e1', source: 'text', sourceHandle: 'text', target: 'ai', targetHandle: 'prompt' }],
    };
    const snapshot = JSON.parse(JSON.stringify(legacy));
    const bundle = migrateV1ToV2(legacy, '2026-07-11T00:00:00.000Z');
    const migrated = bundle.project;
    const imageAssetId = `legacy:${migrated.id}:node:image:active:0:asset`;

    expect(legacy).toEqual(snapshot);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.provenance).toEqual({ legacyProjectId: 'old' });
    expect(migrated.graph.nodes[0]).toMatchObject({
      moduleId: 'core.text-input', config: { text: 'hello' }, updatePolicy: 'manual',
    });
    expect(migrated.graph.nodes[1].config).toEqual({ fileName: 'reference.png', assetId: imageAssetId });
    expect(migrated.graph.nodes[2].config).toEqual({ prompt: 'short', model: 'model/a' });
    expect(JSON.stringify(migrated)).not.toMatch(/base64|runtime result|generated runtime output|history|cost|status|error/);
    expect(bundle.imports.assets).toEqual([{
      id: imageAssetId, nodeId: 'image', fileName: 'reference.png', source: 'active',
      payload: { encoding: 'base64', mediaType: 'image/png', data: 'abc' },
    }]);
    expect(bundle.imports.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'text', active: false, value: { kind: 'text', text: 'runtime result' } }),
      expect.objectContaining({ nodeId: 'image', active: true, value: { kind: 'asset', assetImportId: imageAssetId } }),
      expect.objectContaining({ nodeId: 'ai', active: true, value: { kind: 'text', text: 'generated runtime output' } }),
      expect.objectContaining({ provenance: { legacyId: 'old-result' }, active: false, value: { kind: 'text', text: 'older' } }),
    ]));
    expect(bundle.imports.costs.map((cost) => cost.money.amountMicros)).toEqual(expect.arrayContaining([4_000, 1_250_000, 500_000]));
    expect(migrated.graph.edges[0]).toEqual({
      id: 'e1', sourceNodeId: 'text', sourcePortId: 'text', targetNodeId: 'ai', targetPortId: 'prompt',
      order: 0,
    });
  });

  it('rejects unknown newer schemas instead of guessing', () => {
    expect(() => migrateProject({ schemaVersion: 3 })).toThrow(UnsupportedSchemaVersionError);
  });

  it('migrates renderer slot suffixes into one canonical port with stable order', () => {
    const migrated = migrateV1ToV2({
      schemaVersion: 1,
      nodes: [{id:'a'},{id:'b'},{id:'target'}],
      edges: [
        {id:'one',source:'a',sourceHandle:'text',target:'target',targetHandle:'prompt::0'},
        {id:'two',source:'b',sourceHandle:'text',target:'target',targetHandle:'prompt::1'},
      ],
    }).project.graph.edges;
    expect(migrated.map((edge)=>({port:edge.targetPortId,order:edge.order}))).toEqual([
      {port:'prompt',order:0},{port:'prompt',order:1},
    ]);
  });

  it('namespaces generated imports and retains colliding legacy ids only as provenance', () => {
    const bundle = migrateV1ToV2({ schemaVersion: 1, id: 'same/project', nodes: [
      { id: 'a:b', data: { kind: 'textGeneration', id: 'duplicate', value: 'data:image/png;base64,active', cost: 0.1, history: [
        { id: 'duplicate', value: 'data:image/png;base64,history', cost: 0.2 },
        { id: 'duplicate', value: 'history two', cost: 0.3 },
      ] } },
      { id: 'other', data: { kind: 'textGeneration', id: 'duplicate', value: 'other active', cost: 0.4, history: [
        { id: 'duplicate', value: 'other history', cost: 0.5 },
      ] } },
    ] });
    const ids = [...bundle.imports.results.map((item) => item.id), ...bundle.imports.assets.map((item) => item.id),
      ...bundle.imports.costs.map((item) => item.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(bundle.imports.assets.length).toBe(2);
    expect(bundle.imports.costs.length).toBe(5);
    expect(bundle.imports.results.every((result) => result.provenance?.legacyId === 'duplicate')).toBe(true);
    const prefix = `legacy:${bundle.project.id}`;
    expect(bundle.imports.results.map((result) => result.id)).toEqual(expect.arrayContaining([
      `${prefix}:node:a%3Ab:active:0:result`,
      `${prefix}:node:a%3Ab:history:0:result`,
      `${prefix}:node:a%3Ab:history:1:result`,
      `${prefix}:node:other:active:0:result`,
    ]));
  });

  it('uses deterministic UUIDs, collision-safe fallback edge ids, and rejects ambiguous legacy graphs', () => {
    const legacy = { schemaVersion: 1 as const, name: 'No id', nodes: [
      { id: 'a', data: { kind: 'textInput', value: 'a' } },
      { id: 'b', data: { kind: 'textGeneration', value: 'b' } },
    ], edges: [
      { id: 'legacy:placeholder', source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
    ] };
    const first = migrateV1ToV2(legacy);
    const second = migrateV1ToV2(legacy);
    expect(first.project.id).toBe(second.project.id);
    expect(first.project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(first.project.graph.edges.map((item) => item.id)).size).toBe(2);
    expect(first.project.graph.edges[1].id).toContain(`legacy:${first.project.id}:edge:2:`);
    const fixedId = '8f095c5c-3761-4ad2-98d0-82ae71957335';
    const collidingFallback = `legacy:${fixedId}:edge:2:a:b`;
    const collision = migrateV1ToV2({ ...legacy, id: fixedId, edges: [
      { id: collidingFallback, source: 'a', target: 'b' }, { source: 'a', target: 'b' },
    ] });
    expect(collision.project.graph.edges[1].id).toBe(`${collidingFallback}:1`);
    expect(() => migrateV1ToV2({ schemaVersion: 1, nodes: [{ id: 'same' }, { id: 'same' }] }))
      .toThrow(InvalidLegacyProjectError);
    expect(() => migrateV1ToV2({ schemaVersion: 1, nodes: [{ id: 'a' }, { id: 'b' }], edges: [
      { id: 'same', source: 'a', target: 'b' }, { id: 'same', source: 'a', target: 'b' },
    ] })).toThrow(/duplicate edge id/);
    expect(() => migrateV1ToV2({ schemaVersion: 1, nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'gone' }] }))
      .toThrow(/unknown node/);
  });

  it('fully decodes v2 documents and rejects malformed nested fields', () => {
    const valid = migrateV1ToV2({ schemaVersion: 1, id: 'valid' }).project;
    expect(migrateProject(valid).project).toEqual(valid);
    for (const malformed of [
      { ...valid, graph: null },
      { ...valid, graph: { ...valid.graph, nodes: [{ id: 'x' }] } },
      { ...valid, graph: { ...valid.graph, edges: [{ id: 'e', sourceNodeId: 'a', sourcePortId: 'o', targetNodeId: 'b', targetPortId: 'i', order: -1 }] } },
      { ...valid, graph: { ...valid.graph, groups: [{ id: 'g', name: 'G', nodeIds: [1] }] } },
      { ...valid, canvas: { viewport: { x: 0, y: 0, zoom: Number.NaN } } },
    ]) expect(() => migrateProject(malformed)).toThrow(InvalidProjectDocumentError);
    expect(() => migrateProject(null)).toThrow(InvalidProjectDocumentError);
  });

  it('matches the strict Rust v2 JSON shape including edge order, groups and omitted optionals', () => {
    const document = {
      schemaVersion: 2 as const,
      id: '8f095c5c-3761-4ad2-98d0-82ae71957335', name: 'Cross schema',
      createdAt: '2026-07-11T08:00:00Z', updatedAt: '2026-07-11T08:00:00Z',
      graph: {
        nodes: [{ id: 'n1', moduleId: 'core.text-input', moduleVersion: 1, position: { x: 0, y: 0 }, config: {}, updatePolicy: 'manual' as const }],
        edges: [] as GraphEdge[], groups: [{ id: 'g1', name: 'Group', nodeIds: ['n1'] }],
      },
      canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
    };
    expect(decodeForCrossSchema(document)).toEqual(document);
    expect(() => decodeForCrossSchema({ ...document, graph: { ...document.graph, groups: undefined } })).toThrow(/groups/);
    expect(() => decodeForCrossSchema({ ...document, graph: { ...document.graph, edges: [{
      id: 'e', sourceNodeId: 'n1', sourcePortId: 'out', targetNodeId: 'n1', targetPortId: 'in',
    }] } })).toThrow(/order/);
    expect(() => decodeForCrossSchema({ ...document, graph: { ...document.graph, groups: [
      { id: 'g1', name: 'Group', nodeIds: ['n1', 'n1'] },
    ] } })).toThrow(/duplicate node in group/);
    expect(() => decodeForCrossSchema({ ...document, graph: { ...document.graph, groups: [
      { id: 'g1', name: 'One', nodeIds: ['n1'] }, { id: 'g2', name: 'Two', nodeIds: ['n1'] },
    ] } })).toThrow(/multiple groups/);
  });
});

function decodeForCrossSchema(value: unknown) {
  return migrateProject(value).project;
}
