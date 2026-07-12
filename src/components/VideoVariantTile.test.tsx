import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VideoVariantTile } from './VideoVariantTile';

describe('video variant preview semantics', () => {
  it('keeps native video controls outside the separate selection button', () => {
    const html = renderToStaticMarkup(<VideoVariantTile src="flowz-media://localhost/video" index={0} active={false} onSelect={() => undefined} />);
    expect(html).toContain('<video');
    expect(html).toContain('<button');
    expect(html).not.toMatch(/<button[^>]*>.*<video/s);
    expect(html).toContain('Videovariante 1 abspielen');
    expect(html).toContain('Variante 1 wählen');
  });
});
