import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18N_DICTIONARIES, appErrorMessage, formatCurrency, formatFileSize, localizeErrorMessage, providerError, providerErrorMessage, setLocale, subscribeLocale, t } from './i18n';
import { canonicalStringify } from './engine/fingerprint';

describe('typed interface localization', () => {
  afterEach(() => setLocale('de'));

  it('keeps German and English dictionaries complete without leaking raw keys', () => {
    const german = Object.keys(I18N_DICTIONARIES.de).sort();
    expect(Object.keys(I18N_DICTIONARIES.en).sort()).toEqual(german);
    for (const key of german) {
      setLocale('de'); expect(t(key as keyof typeof I18N_DICTIONARIES.de)).not.toBe(key);
      setLocale('en'); expect(t(key as keyof typeof I18N_DICTIONARIES.de)).not.toBe(key);
    }
  });

  it('interpolates variables and plurals and formats values with the active locale', () => {
    setLocale('de'); expect(t('common.nodes', { count: 1 })).toBe('1 Node'); expect(formatFileSize(1_572_864)).toContain('1,5');
    setLocale('en'); expect(t('common.nodes', { count: 2 })).toBe('2 nodes'); expect(formatCurrency(1.25, 'USD')).toContain('$1.25');
  });

  it('localizes keyboard connections, media variants, asset actions and font previews',()=>{
    setLocale('de');expect(t('connection.title')).toBe('Verbindung erstellen');expect(t('video.variantChoose')).toContain('Variante');expect(t('assets.localImage')).toContain('Bild');expect(t('font.specimenLabel')).toContain('Beispieltext');
    setLocale('en');expect(t('connection.title')).toBe('Create connection');expect(t('video.variantChoose')).toContain('variant');expect(t('assets.localImage')).toContain('image');expect(t('font.specimenLabel')).toContain('specimen');
  });

  it('never adds locale to language-neutral execution data', () => {
    const payload = { moduleId:'ai.text', config:{prompt:'Unchanged'}, bindings:[] };
    setLocale('de'); const german = canonicalStringify(payload);
    setLocale('en'); expect(canonicalStringify(payload)).toBe(german);
  });

  it('persists safely, updates document language and notifies reactive consumers',()=>{const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:()=>null,setItem});const root={lang:'de'};vi.stubGlobal('document',{documentElement:root});const changed=vi.fn();const unsubscribe=subscribeLocale(changed);setLocale('en');expect(setItem).toHaveBeenCalledWith('flowz:locale','en');expect(root.lang).toBe('en');expect(changed).toHaveBeenCalledOnce();unsubscribe();vi.unstubAllGlobals();});

  it('preserves provider details verbatim while localizing their ownership',()=>{setLocale('en');const detail='Bild Text mapped phrases · quota=7';expect(localizeErrorMessage(providerError('fal.ai',detail))).toBe(`fal.ai: ${detail}`);expect(localizeErrorMessage('Interner deutscher Detailfehler')).toBe('The operation could not be completed.');});

  it('redacts provider URLs and synthetic credential fixtures before display',()=>{setLocale('en');const secrets=[['BSA','fixturetoken0000000000'].join(''),['00000000','-0000-0000-0000-000000000000',':','00000000000000000000000000000000'].join(''),['sk-or-v1-','fixture_token_000000000000'].join('')];for(const secret of secrets)expect(localizeErrorMessage(providerError('provider',`failed ${secret} ftp://private.example/file`))).toBe('provider: failed [REDACTED] [URL]');});

  it('localizes serialized typed errors while preserving actionable redacted detail',()=>{setLocale('en');expect(localizeErrorMessage(appErrorMessage('validation_failed','A prompt is required.'))).toBe('Check the inputs. A prompt is required.');expect(localizeErrorMessage(providerErrorMessage('fal.ai','HTTP 429 at https://private.example'))).toBe('fal.ai: HTTP 429 at [URL]');});

  it('keeps user, asset, generated and Markdown content byte-for-byte invariant',()=>{const content={projectName:'Bild',nodeLabel:'Text',assetName:'Weitere Einstellungen',prompt:'Bild generieren',markdown:'# Bild\n\n**Text**',provider:'Bild Text mapped phrases'};setLocale('de');const before=JSON.stringify(content);setLocale('en');expect(JSON.stringify(content)).toBe(before);});
});
