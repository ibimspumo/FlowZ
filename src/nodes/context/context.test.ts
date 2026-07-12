import { describe, expect, it } from 'vitest';
import { formatWebpageMarkdown } from './webpage';
import { researchModule } from './research';
import { webpageModule } from './webpage';
import { assetTextModule } from './asset-reference';

describe('context node transforms', () => {
  it('keeps extracted page text from becoming executable markdown', () => {
    expect(formatWebpageMarkdown('[Fake](javascript:alert(1))', 'https://example.com/', '**bold** [bad](javascript:x)', false))
      .toContain('\\[Fake\\]\\(javascript:alert\\(1\\)\\)');
    expect(formatWebpageMarkdown('Safe', 'https://example.com/a%3E%29', 'Text', false)).toContain('[Quelle](<https://example.com/a%3E%29>)');
    expect(formatWebpageMarkdown('Safe', 'https://example.com/>)[bad](javascript:x)', 'Text', false)).not.toContain('](javascript:');
  });

  it('executes web and research modules through injected services with the actual query', async () => {
    const base = { id: 'node', moduleVersion: 1, position: { x: 0, y: 0 }, updatePolicy: 'manual' as const };
    const research = await researchModule.execute({ ...base, moduleId: researchModule.id, config: { query: 'Marke', resultCount: 5, freshness: 'week' } }, {
      signal: new AbortController().signal,
      inputs: { query: [{ kind: 'scalar', value: { type: 'text', value: 'Berlin' } }] },
      services: { research: { search: async (request) => ({ provider: 'Test', markdown: request.query, resultCount: 1 }) } },
    });
    expect(research.metadata?.executedQuery).toBe('Berlin Marke');
    const webpage = await webpageModule.execute({ ...base, moduleId: webpageModule.id, config: { url: 'https://example.com', includeScreenshot: true } }, {
      signal: new AbortController().signal, inputs: {}, services: { webpage: { fetch: async () => ({ finalUrl: 'https://example.com/', title: 'Example', text: 'Body', screenshotDataUrl: 'data:image/png;base64,AA', screenshotProvider: 'Test', truncated: false }) } },
    });
    expect(webpage.metadata?.screenshotDataUrl).toBe('data:image/png;base64,AA');
  });

  it('resolves an immutable asset version through the execution service', async () => {
    const result = await assetTextModule.execute({ id: 'asset', moduleId: assetTextModule.id, moduleVersion: 1, position: { x: 0, y: 0 }, updatePolicy: 'manual', config: { libraryAssetId: 'a', assetVersionId: 'v1', assetVersion: 1, assetName: 'Prompt', assetKind: 'prompt' } }, {
      signal: new AbortController().signal, inputs: {}, services: { assets: { get: async (versionId) => ({ text: versionId === 'v1' ? 'Immutable' : undefined }) } },
    });
    expect(result.outputs.text).toEqual({ kind: 'scalar', value: { type: 'text', value: 'Immutable' } });
  });
});
