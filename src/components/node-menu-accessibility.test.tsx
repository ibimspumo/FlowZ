import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { setLocale, t } from '../i18n';
import { NodeMenu } from './NodeMenu';

describe('NodeMenu accessibility contract', () => {
  it('exposes the compact template picker as a non-modal dialog with tabs', () => {
    const html = renderToStaticMarkup(<NodeMenu
      state={{ screen:{x:10,y:20},flow:{x:30,y:40},initialView:'templates' }}
      onSelect={() => undefined} onSelectTemplate={() => undefined} onClose={() => undefined}
    />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('Vorlage suchen');
    expect(html).toContain('aria-label="Schließen"');
  });

  it('describes paid template nodes as deliberate rather than automatic charges', () => {
    setLocale('de');
    expect(t('menu.variableCost',{count:3})).toContain('nur bewusst gestartete Schritte');
    setLocale('en');
    expect(t('menu.variableCost',{count:3})).toContain('Only deliberately started steps');
    setLocale('de');
  });

  it('keeps connection completion focused on compatible nodes', () => {
    const html = renderToStaticMarkup(<NodeMenu
      state={{ screen:{x:10,y:20},flow:{x:30,y:40},initialView:'templates',pending:{nodeId:'a',handleId:'image',handleType:'source',dataType:'image'} }}
      onSelect={() => undefined} onSelectTemplate={() => undefined} onClose={() => undefined}
    />);
    expect(html).toContain('Bild · kompatible Eingänge');
    expect(html).not.toContain('Vorlagen');
  });

  it('shows compact purpose metadata without requiring users to insert a node first',()=>{
    setLocale('en');
    const html=renderToStaticMarkup(<NodeMenu state={{screen:{x:0,y:0},flow:{x:0,y:0}}} onSelect={()=>undefined} onSelectTemplate={()=>undefined} onClose={()=>undefined}/>);
    expect(html).toContain('Text+Image+List → Image+List · Provider');
    expect(html).toContain('aria-description=');
    expect(html).toContain('— → Text · Local');
    setLocale('de');
  });
});
