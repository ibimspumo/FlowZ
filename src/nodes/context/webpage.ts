import { scalarType } from '../../domain/values';
import { DefaultNodeIcon, DefaultNodeView, defineNodeModule } from '../../engine/node-module';

function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, '\\$&');
}

function safeMarkdownUrl(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Nur http(s)-Quellen können dargestellt werden.');
  return parsed.href.replace(/[<>\\()[\]]/g, (character) => encodeURIComponent(character));
}

export function formatWebpageMarkdown(title: string | undefined, url: string, text: string, truncated: boolean): string {
  return [`# ${escapeMarkdownText(title ?? url)}`, '', escapeMarkdownText(text), '', `[Quelle](<${safeMarkdownUrl(url)}>)${truncated ? ' · auf 40.000 Zeichen begrenzt' : ''}`].join('\n');
}

export const webpageModule = defineNodeModule({
  id: 'context.webpage',
  version: 1,
  label: 'Webseite lesen',
  category: 'context',
  inputs: [{ id: 'url', label: 'Text', valueType: scalarType('text'), optional: true }],
  outputs: [
    { id: 'text', label: 'Text', valueType: scalarType('text') },
    { id: 'screenshot', label: 'Bild', valueType: scalarType('image') },
  ],
  defaultConfig: { url: '', includeScreenshot: false },
  View: DefaultNodeView,
  Icon: DefaultNodeIcon,
  validateConfig: (config): config is { url: string; includeScreenshot: boolean } => typeof config.url === 'string' && typeof config.includeScreenshot === 'boolean',
  async execute(node, context) {
    const service = context.services?.webpage;
    if (!service) throw new Error('Der Webseiten-Dienst ist in dieser Laufzeit nicht verfügbar.');
    const connected = (context.inputs.url ?? []).find((value) => value.kind === 'scalar' && value.value.type === 'text');
    const url = connected?.kind === 'scalar' && connected.value.type === 'text' ? connected.value.value.trim() : node.config.url.trim();
    if (!url) throw new Error('Verbinde einen URL-Text oder trage eine URL ein.');
    context.signal.throwIfAborted();
    const page = await service.fetch({ url, includeScreenshot: node.config.includeScreenshot });
    context.signal.throwIfAborted();
    const text = formatWebpageMarkdown(page.title, page.finalUrl, page.text, page.truncated);
    return {
      outputs: {
        text: { kind: 'scalar', value: { type: 'text', value: text } },
        ...(page.screenshotDataUrl ? { screenshot: { kind: 'scalar' as const, value: { type: 'image' as const, assetId: 'pending:webpage-screenshot' } } } : {}),
      },
      metadata: { text, finalUrl: page.finalUrl, truncated: page.truncated, includeScreenshot: node.config.includeScreenshot, screenshotProvider: page.screenshotProvider ?? 'keiner', ...(page.screenshotDataUrl ? { screenshotDataUrl: page.screenshotDataUrl } : {}) },
    };
  },
});
