import {
  CURRENT_SCHEMA_VERSION,
  microUnits,
  type GraphNode,
  type JsonValue,
  type Money,
  type ProjectDocument,
} from './project';
import { isMediaNodeConfig, normalizeMediaNodeConfig } from './media-config';
import { persistedModuleIdForKind } from '../nodes/module-ids';

export type LegacyV1Node = {
  id: string;
  position?: { x?: number; y?: number };
  data?: Record<string, unknown>;
};

export type LegacyV1Edge = {
  id?: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
};

export type LegacyProjectV1 = {
  schemaVersion: 1;
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  nodes?: LegacyV1Node[];
  edges?: LegacyV1Edge[];
};

export type Base64PayloadDescriptor = {
  encoding: 'base64';
  mediaType: string;
  data: string;
};

export type LegacyAssetImport = {
  id: string;
  nodeId: string;
  fileName?: string;
  source: 'active' | 'history';
  payload: Base64PayloadDescriptor;
  provenance?: { legacyId: string };
};

export type LegacyResultImport = {
  id: string;
  nodeId: string;
  createdAt?: string;
  active: boolean;
  model?: string;
  value: { kind: 'text'; text: string } | { kind: 'asset'; assetImportId: string };
  provenance?: { legacyId: string };
};

export type LegacyCostImport = {
  id: string;
  nodeId: string;
  resultImportId?: string;
  money: Money;
  provenance?: { legacyId: string };
};

export type LegacyImportBundle = {
  project: ProjectDocument;
  /** Original non-UUID identifier retained when the persisted v2 id had to be replaced. */
  provenance?: { legacyProjectId: string };
  imports: {
    assets: LegacyAssetImport[];
    results: LegacyResultImport[];
    costs: LegacyCostImport[];
  };
};

export class InvalidLegacyProjectError extends Error {
  constructor(readonly path: string, message: string) {
    super(`Invalid legacy project at ${path}: ${message}`);
    this.name = 'InvalidLegacyProjectError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Stable UUID-shaped identity for legacy projects; migration remains pure and repeatable. */
function deterministicUuid(namespace: string, value: string): string {
  const bytes = new Uint8Array(16);
  const input = new TextEncoder().encode(`${namespace}\0${value}`);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  seeds.forEach((seed, word) => {
    let hash = seed >>> 0;
    for (const byte of input) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= hash >>> 13;
    }
    for (let offset = 0; offset < 4; offset += 1) bytes[word * 4 + offset] = (hash >>> (offset * 8)) & 0xff;
  });
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateLegacyGraph(project: LegacyProjectV1): void {
  const nodes = project.nodes ?? [];
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => {
    if (typeof node.id !== 'string' || !node.id) throw new InvalidLegacyProjectError(`$.nodes[${index}].id`, 'expected non-empty string');
    if (nodeIds.has(node.id)) throw new InvalidLegacyProjectError(`$.nodes[${index}].id`, `duplicate node id ${JSON.stringify(node.id)}`);
    nodeIds.add(node.id);
  });
  const edgeIds = new Set<string>();
  (project.edges ?? []).forEach((edge, index) => {
    if (!nodeIds.has(edge.source)) throw new InvalidLegacyProjectError(`$.edges[${index}].source`, `unknown node ${JSON.stringify(edge.source)}`);
    if (!nodeIds.has(edge.target)) throw new InvalidLegacyProjectError(`$.edges[${index}].target`, `unknown node ${JSON.stringify(edge.target)}`);
    if (edge.id !== undefined) {
      if (!edge.id) throw new InvalidLegacyProjectError(`$.edges[${index}].id`, 'expected non-empty string when present');
      if (edgeIds.has(edge.id)) throw new InvalidLegacyProjectError(`$.edges[${index}].id`, `duplicate edge id ${JSON.stringify(edge.id)}`);
      edgeIds.add(edge.id);
    }
  });
}

const CONFIG_KEYS: Record<string, readonly string[]> = {
  textInput: ['value'], imageInput: ['assetId', 'fileName'],
  textGeneration: ['prompt', 'model', 'outputMode', 'variantCount', 'listProcessingMode'],
  imageGeneration: ['prompt', 'model', 'aspectRatio', 'resolution', 'variantCount', 'variants', 'seed', 'outputFormat', 'quality', 'background', 'inputFidelity', 'safetyTolerance', 'thinkingLevel', 'webSearch', 'steps', 'guidance', 'acceleration', 'safetyChecker', 'imageEndpointConfigs'],
  imageUpscale: ['model', 'upscaleMode', 'factor', 'targetResolution', 'outputFormat', 'seed', 'noise', 'topazModel', 'faceEnhancement', 'subjectDetection', 'faceEnhancementCreativity', 'faceEnhancementStrength', 'sharpen', 'denoise', 'fixCompression', 'strength', 'creativity', 'texture', 'redefinePrompt', 'autoprompt', 'detail', 'enhancementStrength', 'premiumConfirmed', 'cropToFill'],
  imageTransform: ['transformMode','transformAspect','targetWidth','targetHeight','dimensionLock','noUpscale','outputFormat','transformQuality','transformBackground','cropX','cropY','cropWidth','cropHeight','listProcessingMode'],
  imageTrimTransparent: ['trimPadding','trimThreshold','listProcessingMode'],
  backgroundRemoval: ['model'],
  imageAnalysis: ['prompt', 'model', 'outputMode', 'variantCount', 'listProcessingMode'],
};

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function parseDataUrl(value: unknown): Base64PayloadDescriptor | null {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(value);
  return match ? { encoding: 'base64', mediaType: match[1], data: match[2] } : null;
}

function migrateConfig(kind: string, data: Record<string, unknown>): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = {};
  for (const key of CONFIG_KEYS[kind] ?? []) {
    const value = data[key];
    if (isJsonValue(value) && !parseDataUrl(value)) config[key === 'value' && kind === 'textInput' ? 'text' : key] = value;
  }
  return config;
}

function migrateNode(node: LegacyV1Node): GraphNode {
  const data = node.data ?? {};
  const kind = typeof data.kind === 'string' ? data.kind : 'unknown';
  return {
    id: node.id,
    moduleId: persistedModuleIdForKind(kind) ?? `legacy.${kind}`,
    moduleVersion: 1,
    position: { x: typeof node.position?.x === 'number' ? node.position.x : 0, y: typeof node.position?.y === 'number' ? node.position.y : 0 },
    ...(typeof data.label === 'string' ? { label: data.label } : {}),
    config: migrateConfig(kind, data),
    updatePolicy: 'manual',
  };
}

function dollarCost(value: unknown): Money | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? { amountMicros: microUnits(Math.round(value * 1_000_000)), currency: 'USD' }
    : null;
}

function importId(projectId: string, nodeId: string, source: 'active' | 'history', ordinal: number, entity: 'result' | 'asset' | 'cost'): string {
  const segment = (value: string) => encodeURIComponent(value);
  return `legacy:${segment(projectId)}:node:${segment(nodeId)}:${source}:${ordinal}:${entity}`;
}

/** Pure v1 import. Runtime records stay outside ProjectDocument but are retained for library import. */
export function migrateV1ToV2(project: LegacyProjectV1, migratedAt = '1970-01-01T00:00:00.000Z'): LegacyImportBundle {
  validateLegacyGraph(project);
  const legacyIdentity = typeof project.id === 'string' && project.id ? project.id : canonicalLegacyIdentity(project);
  const projectId = isUuid(project.id) ? project.id : deterministicUuid('dev.flowz.legacy-project.v1', legacyIdentity);
  const nodes = (project.nodes ?? []).map(migrateNode);
  const portOrder = new Map<string, number>();
  const reservedEdgeIds = new Set((project.edges ?? []).flatMap((edge) => edge.id ? [edge.id] : []));
  const allocatedEdgeIds = new Set<string>();
  const edges = (project.edges ?? []).map((edge, index) => {
    // Older React Flow snapshots sometimes persisted the visual many-slot
    // suffix (`prompt::1`). The domain owns a canonical port plus a separate
    // order, so never carry the renderer-only suffix into the v2 graph.
    const targetPortId = (edge.targetHandle ?? 'input').split('::')[0];
    const orderKey = `${edge.target}\0${targetPortId}`;
    const order = portOrder.get(orderKey) ?? 0;
    portOrder.set(orderKey, order + 1);
    let id = edge.id;
    if (!id) {
      const base = `legacy:${encodeURIComponent(projectId)}:edge:${index + 1}:${encodeURIComponent(edge.source)}:${encodeURIComponent(edge.target)}`;
      id = base;
      let suffix = 1;
      while (reservedEdgeIds.has(id) || allocatedEdgeIds.has(id)) id = `${base}:${suffix++}`;
    }
    allocatedEdgeIds.add(id);
    return {
      id, sourceNodeId: edge.source, sourcePortId: (edge.sourceHandle ?? 'output').split('::')[0],
      targetNodeId: edge.target, targetPortId, order,
    };
  });

  const assets: LegacyAssetImport[] = [];
  const results: LegacyResultImport[] = [];
  const costs: LegacyCostImport[] = [];
  const addResult = (node: LegacyV1Node, raw: Record<string, unknown>, active: boolean, ordinal: number) => {
    const value = raw.value;
    if (typeof value !== 'string') return;
    const source = active ? 'active' : 'history';
    const resultId = importId(projectId, node.id, source, ordinal, 'result');
    const provenance = typeof raw.id === 'string' ? { provenance: { legacyId: raw.id } } : {};
    const payload = parseDataUrl(value);
    let importedValue: LegacyResultImport['value'];
    if (payload) {
      const assetId = importId(projectId, node.id, source, ordinal, 'asset');
      assets.push({ id: assetId, nodeId: node.id, source: active ? 'active' : 'history', payload,
        ...provenance,
        ...(typeof (node.data ?? {}).fileName === 'string' ? { fileName: (node.data ?? {}).fileName as string } : {}) });
      importedValue = { kind: 'asset', assetImportId: assetId };
      if (active && (node.data ?? {}).kind === 'imageInput') {
        const migratedNode = nodes.find((candidate) => candidate.id === node.id);
        if (migratedNode) migratedNode.config.assetId = assetId;
      }
    } else importedValue = { kind: 'text', text: value };
    results.push({ id: resultId, nodeId: node.id, active, ...provenance,
      ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {}),
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}), value: importedValue });
    const money = dollarCost(raw.cost);
    if (money) costs.push({ id: importId(projectId, node.id, source, ordinal, 'cost'), nodeId: node.id, resultImportId: resultId, money,
      ...provenance });
  };

  for (const node of project.nodes ?? []) {
    const data = node.data ?? {};
    // Text input values are editable configuration, not generated results.
    if (data.kind !== 'textInput') addResult(node, data, true, 0);
    if (Array.isArray(data.history)) data.history.forEach((item, index) => {
      if (item && typeof item === 'object') addResult(node, item as Record<string, unknown>, false, index);
    });
    const nodeMoney = dollarCost(data.cost);
    if (nodeMoney && !results.some((result) => result.nodeId === node.id && result.active)) {
      costs.push({ id: importId(projectId, node.id, 'active', 0, 'cost'), nodeId: node.id, money: nodeMoney });
    }
  }

  const bundle: LegacyImportBundle = {
    project: {
      schemaVersion: CURRENT_SCHEMA_VERSION, id: projectId, name: project.name ?? 'Migriertes Projekt',
      createdAt: project.createdAt ?? migratedAt, updatedAt: project.updatedAt ?? migratedAt,
      graph: { nodes, edges, groups: [] }, canvas: { viewport: { x: 0, y: 0, zoom: 1 } },
    },
    ...(!isUuid(project.id) && typeof project.id === 'string' ? { provenance: { legacyProjectId: project.id } } : {}),
    imports: { assets, results, costs },
  };
  bundle.project = decodeProjectDocument(bundle.project);
  return bundle;
}

function canonicalLegacyIdentity(project: LegacyProjectV1): string {
  const nodeIds = (project.nodes ?? []).map((node) => node.id).sort().join('\0');
  const edges = (project.edges ?? []).map((edge) => `${edge.source}\0${edge.sourceHandle ?? ''}\0${edge.target}\0${edge.targetHandle ?? ''}`).sort().join('\u0001');
  return `${project.name ?? ''}\u0002${project.createdAt ?? ''}\u0002${nodeIds}\u0002${edges}`;
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly schemaVersion: unknown) {
    super(`Unsupported project schema version: ${String(schemaVersion)}`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export class InvalidProjectDocumentError extends Error {
  constructor(readonly path: string, message: string) {
    super(`Invalid project document at ${path}: ${message}`);
    this.name = 'InvalidProjectDocumentError';
  }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidProjectDocumentError(path, 'expected object');
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new InvalidProjectDocumentError(path, 'expected string');
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidProjectDocumentError(path, 'expected finite number');
  return value;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidProjectDocumentError(path, 'expected array');
  return value;
}

function isoDateAt(value: unknown, path: string): string {
  const string = stringAt(value, path);
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(string) || !Number.isFinite(Date.parse(string))) throw new InvalidProjectDocumentError(path, 'expected RFC 3339 date-time');
  return string;
}

export function decodeProjectDocument(value: unknown): ProjectDocument {
  const root = recordAt(value, '$');
  if (root.schemaVersion !== CURRENT_SCHEMA_VERSION) throw new InvalidProjectDocumentError('$.schemaVersion', `expected ${CURRENT_SCHEMA_VERSION}`);
  const graph = recordAt(root.graph, '$.graph');
  const canvas = recordAt(root.canvas, '$.canvas');
  const viewport = recordAt(canvas.viewport, '$.canvas.viewport');

  if (!isUuid(root.id)) throw new InvalidProjectDocumentError('$.id', 'expected UUID');
  if (typeof root.name !== 'string' || !root.name.trim()) throw new InvalidProjectDocumentError('$.name', 'expected non-empty string');

  const nodes = arrayAt(graph.nodes, '$.graph.nodes').map((raw, index) => {
    const path = `$.graph.nodes[${index}]`;
    const item = recordAt(raw, path);
    const position = recordAt(item.position, `${path}.position`);
    let config = recordAt(item.config, `${path}.config`);
    if (!isJsonValue(config)) throw new InvalidProjectDocumentError(`${path}.config`, 'expected JSON values');
    if (!Number.isSafeInteger(item.moduleVersion) || (item.moduleVersion as number) < 1) {
      throw new InvalidProjectDocumentError(`${path}.moduleVersion`, 'expected positive safe integer');
    }
    if (!['manual', 'auto', 'frozen'].includes(String(item.updatePolicy))) {
      throw new InvalidProjectDocumentError(`${path}.updatePolicy`, 'expected manual, auto or frozen');
    }
    if (item.label !== undefined && typeof item.label !== 'string') throw new InvalidProjectDocumentError(`${path}.label`, 'expected string');
    if (item.labelId !== undefined && (typeof item.labelId !== 'string' || !/^(node:[a-zA-Z]+|template:[a-z0-9-]+:[a-zA-Z0-9-]+)$/.test(item.labelId))) throw new InvalidProjectDocumentError(`${path}.labelId`, 'expected canonical label id');
    const id = stringAt(item.id, `${path}.id`);
    const moduleId = stringAt(item.moduleId, `${path}.moduleId`);
    if (!id) throw new InvalidProjectDocumentError(`${path}.id`, 'expected non-empty string');
    if (!moduleId) throw new InvalidProjectDocumentError(`${path}.moduleId`, 'expected non-empty string');
    if (moduleId === 'core.video-input' || moduleId === 'core.audio-input') {
      const kind = moduleId === 'core.video-input' ? 'video' : 'audio';
      config = normalizeMediaNodeConfig(config as Record<string, JsonValue>, kind);
      if (!isMediaNodeConfig(config as Record<string, JsonValue>, kind)) throw new InvalidProjectDocumentError(`${path}.config`, `invalid ${kind} media config`);
    }
    if (moduleId === 'ai.transcription') {
      const keys = Object.keys(config);
      const language = config.language;
      if (keys.some((key) => !['model', 'language', 'timestamps'].includes(key))
        || typeof config.model !== 'string' || !config.model || config.model.length > 200
        || typeof language !== 'string' || !(language === 'auto' || /^[a-z]{2}$/.test(language))
        || typeof config.timestamps !== 'boolean') {
        throw new InvalidProjectDocumentError(`${path}.config`, 'invalid transcription config');
      }
    }
    return {
      id, moduleId,
      moduleVersion: item.moduleVersion as number,
      position: { x: numberAt(position.x, `${path}.position.x`), y: numberAt(position.y, `${path}.position.y`) },
      ...(item.label !== undefined ? { label: item.label as string } : {}), ...(item.labelId !== undefined ? { labelId:item.labelId as string } : {}), config: config as Record<string, JsonValue>,
      updatePolicy: item.updatePolicy as GraphNode['updatePolicy'],
    };
  });

  const edges = arrayAt(graph.edges, '$.graph.edges').map((raw, index) => {
    const path = `$.graph.edges[${index}]`;
    const item = recordAt(raw, path);
    if (!Number.isSafeInteger(item.order) || (item.order as number) < 0) throw new InvalidProjectDocumentError(`${path}.order`, 'expected non-negative safe integer');
    const decoded = { id: stringAt(item.id, `${path}.id`), sourceNodeId: stringAt(item.sourceNodeId, `${path}.sourceNodeId`),
      sourcePortId: stringAt(item.sourcePortId, `${path}.sourcePortId`), targetNodeId: stringAt(item.targetNodeId, `${path}.targetNodeId`),
      targetPortId: stringAt(item.targetPortId, `${path}.targetPortId`), order: item.order as number };
    for (const [key, field] of Object.entries(decoded)) {
      if (key !== 'order' && !field) throw new InvalidProjectDocumentError(`${path}.${key}`, 'expected non-empty string');
    }
    return decoded;
  });

  const groups = arrayAt(graph.groups, '$.graph.groups').map((raw, index) => {
    const path = `$.graph.groups[${index}]`;
    const item = recordAt(raw, path);
    if (item.color !== undefined && typeof item.color !== 'string') throw new InvalidProjectDocumentError(`${path}.color`, 'expected string');
    if (item.description !== undefined && typeof item.description !== 'string') throw new InvalidProjectDocumentError(`${path}.description`, 'expected string');
    const id = stringAt(item.id, `${path}.id`);
    const name = stringAt(item.name, `${path}.name`);
    if (!id) throw new InvalidProjectDocumentError(`${path}.id`, 'expected non-empty string');
    if (!name.trim()) throw new InvalidProjectDocumentError(`${path}.name`, 'expected non-empty string');
    return { id, name,
      nodeIds: arrayAt(item.nodeIds, `${path}.nodeIds`).map((id, nodeIndex) => stringAt(id, `${path}.nodeIds[${nodeIndex}]`)),
      ...(item.color !== undefined ? { color: item.color as string } : {}),
      ...(item.description !== undefined ? { description: item.description as string } : {}) };
  });

  const x = numberAt(viewport.x, '$.canvas.viewport.x');
  const y = numberAt(viewport.y, '$.canvas.viewport.y');
  const zoom = numberAt(viewport.zoom, '$.canvas.viewport.zoom');
  if (zoom <= 0) throw new InvalidProjectDocumentError('$.canvas.viewport.zoom', 'expected positive number');

  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new InvalidProjectDocumentError('$.graph.nodes', 'duplicate node ids');
  const edgeIds = new Set<string>();
  const targetOrders = new Set<string>();
  edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.sourceNodeId)) throw new InvalidProjectDocumentError(`$.graph.edges[${index}].sourceNodeId`, 'unknown node');
    if (!nodeIds.has(edge.targetNodeId)) throw new InvalidProjectDocumentError(`$.graph.edges[${index}].targetNodeId`, 'unknown node');
    if (edgeIds.has(edge.id)) throw new InvalidProjectDocumentError(`$.graph.edges[${index}].id`, 'duplicate edge id');
    edgeIds.add(edge.id);
    const slot = `${edge.targetNodeId}\0${edge.targetPortId}\0${edge.order}`;
    if (targetOrders.has(slot)) throw new InvalidProjectDocumentError(`$.graph.edges[${index}].order`, 'duplicate order at target port');
    targetOrders.add(slot);
  });
  const groupIds = new Set<string>();
  const groupedNodeIds = new Set<string>();
  groups.forEach((group, index) => {
    if (groupIds.has(group.id)) throw new InvalidProjectDocumentError(`$.graph.groups[${index}].id`, 'duplicate group id');
    groupIds.add(group.id);
    const membersInGroup = new Set<string>();
    group.nodeIds.forEach((nodeId, memberIndex) => {
      if (!nodeIds.has(nodeId)) throw new InvalidProjectDocumentError(`$.graph.groups[${index}].nodeIds[${memberIndex}]`, 'unknown node');
      if (membersInGroup.has(nodeId)) throw new InvalidProjectDocumentError(`$.graph.groups[${index}].nodeIds[${memberIndex}]`, 'duplicate node in group');
      if (groupedNodeIds.has(nodeId)) throw new InvalidProjectDocumentError(`$.graph.groups[${index}].nodeIds[${memberIndex}]`, 'node belongs to multiple groups');
      membersInGroup.add(nodeId);
      groupedNodeIds.add(nodeId);
    });
  });

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION, id: root.id, name: root.name,
    createdAt: isoDateAt(root.createdAt, '$.createdAt'), updatedAt: isoDateAt(root.updatedAt, '$.updatedAt'),
    graph: { nodes, edges, groups }, canvas: { viewport: { x, y, zoom } },
  };
}

export function migrateProject(project: unknown): LegacyImportBundle {
  const candidate = recordAt(project, '$');
  if (candidate.schemaVersion === 1) return migrateV1ToV2(candidate as LegacyProjectV1);
  if (candidate.schemaVersion === CURRENT_SCHEMA_VERSION) {
    return { project: decodeProjectDocument(candidate), imports: { assets: [], results: [], costs: [] } };
  }
  throw new UnsupportedSchemaVersionError(candidate.schemaVersion);
}
