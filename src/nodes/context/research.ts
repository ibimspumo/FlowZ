import { scalarType } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';

export const researchModule = defineNodeModule({
  id: 'context.research',
  version: 1,
  label: 'Web-Recherche',
  category: 'context',
  inputs: [{ id: 'query', label: 'Text', valueType: scalarType('text'), optional: true, cardinality: 'many' }],
  outputs: [{ id: 'text', label: 'Text', valueType: scalarType('text') }],
  defaultConfig: { query: '', resultCount: 8, freshness: 'all' as const },
  View: DefaultNodeView,
  Icon: DefaultNodeIcon,
  validateConfig: (config): config is { query: string; resultCount: number; freshness: 'all' | 'day' | 'week' | 'month' | 'year' } => {
    const count = config.resultCount;
    return typeof config.query === 'string' && typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 20
      && typeof config.freshness === 'string' && ['all', 'day', 'week', 'month', 'year'].includes(config.freshness);
  },
  async execute(node, context) {
    const service = context.services?.research;
    if (!service) throw new Error('Der Recherche-Dienst ist in dieser Laufzeit nicht verfügbar.');
    const connected = (context.inputs.query ?? []).flatMap((value) => value.kind === 'scalar' && value.value.type === 'text' ? [value.value.value] : []);
    const query = [connected.join(' '), node.config.query].filter(Boolean).join(' ').trim();
    if (!query) throw new Error('Verbinde einen Suchtext oder trage eine Suchanfrage ein.');
    context.signal.throwIfAborted();
    const result = await service.search({ query, resultCount: node.config.resultCount, freshness: node.config.freshness });
    context.signal.throwIfAborted();
    return { outputs: { text: { kind: 'scalar', value: { type: 'text', value: result.markdown } } }, metadata: { provider: result.provider, resultCount: result.resultCount, freshness: node.config.freshness, executedQuery: query } };
  },
});
