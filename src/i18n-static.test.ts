import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';

const files=[
  'App.tsx','components/ModuleNodeComponent.tsx','components/BrandArtifactView.tsx','components/AssetPalette.tsx','components/SaveAssetDialog.tsx','components/NodeMenu.tsx','components/FontPicker.tsx',
  'home/HomeScreen.tsx','home/DocumentTabs.tsx','home/DocumentActionDialog.tsx',
  'artboard-workspace/ArtboardWorkspace.tsx','artboard-workspace/ArtboardCanvas.tsx','artboard-workspace/ArtboardDocumentSurface.tsx','artboard-workspace/ArtboardExportPopover.tsx',
  'artboard-agent-ui/ArtboardDesignAgent.tsx','components/Settings.tsx','components/DataManagerPalette.tsx','nodes/extracted-node-views.tsx',
];

const newlyLocalizedFiles=files.slice(7);
const forbiddenVisibleCopy=[
  'Projekte durchsuchen','Projekt umbenennen','Nicht gespeicherte Änderungen','Artboard-Werkzeuge','Wähle ein Artboard aus',
  'Designänderung beschreiben','Vorschlag prüfen','Verfügbarkeit wird geprüft','Exportordner wählen','Nichts wird automatisch gelöscht',
  'Nodes gruppieren','Kostenpflichtigen Workflow bestätigen','aria-label="Zoom"','aria-label="Provider"','<legend>Reasoning</legend>','>Subscription Token<',
];

describe('static UI localization coverage',()=>{
  it('has no runtime tree translator or raw German JSX/ARIA copy on guarded surfaces',()=>{
    const violations:string[]=[];
    for(const file of files){const source=readFileSync(new URL(`./${file}`,import.meta.url),'utf8');expect(source).not.toContain('LocalizedUi');
      source.split('\n').forEach((line,index)=>{
        const direct=/>\s*[^<{\n]*[ÄÖÜäöüß][^<{\n]*</.test(line);
        const attribute=/(?:aria-label|title|placeholder)="[^"]*[ÄÖÜäöüß][^"]*"/.test(line);
        if(direct||attribute)violations.push(`${file}:${index+1}:${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('routes newly added surfaces through the reactive locale store instead of inline language branches',()=>{
    for(const file of newlyLocalizedFiles){
      const source=readFileSync(new URL(`./${file}`,import.meta.url),'utf8');
      expect(source,`${file} must subscribe to locale changes`).toContain('useI18n');
      expect(source,`${file} must not branch visible copy by locale`).not.toMatch(/locale\s*===\s*['"]de['"]\s*\?/);
      for(const copy of forbiddenVisibleCopy)expect(source,`${file} contains raw visible copy: ${copy}`).not.toContain(copy);
    }
  });

  it('does not hand-roll visible language branches on any guarded surface',()=>{
    for(const file of ['App.tsx',...newlyLocalizedFiles]){
      const source=readFileSync(new URL(`./${file}`,import.meta.url),'utf8');
      expect(source,`${file} must use translation keys instead of inline locale ternaries`).not.toMatch(/locale\s*===\s*['"](?:de|en)['"]\s*\?/);
      for(const copy of forbiddenVisibleCopy)expect(source,`${file} contains raw visible copy: ${copy}`).not.toContain(copy);
    }
  });
});
