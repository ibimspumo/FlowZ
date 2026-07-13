import {describe,expect,it} from 'vitest';
import {resultExportItems,resultExportLabel,resultExportRun} from './result-export';
import {setLocale} from '../i18n';

describe('result export copy',()=>{
  it('prioritizes semantic node/media type over the presence of a blob hash',()=>{
    setLocale('de');
    expect(resultExportLabel('videoGeneration','video/mp4')).toBe('Video exportieren');
    expect(resultExportLabel('imageGeneration','image/png')).toBe('Bild exportieren');
    expect(resultExportLabel('transcription')).toBe('Text exportieren');
    setLocale('en');expect(resultExportLabel('videoGeneration')).toBe('Export video');setLocale('de');
  });
});

it('builds deterministic export payloads for text and persisted media',()=>{
  const items=[
    {id:'a',runId:'run-1',createdAt:'2026-01-01',value:'Hello'},
    {id:'b',runId:'run-1',createdAt:'2026-01-02',value:'flowz://preview',blobHash:'a'.repeat(64)},
  ];
  expect(resultExportItems(items)).toEqual([{text:'Hello'},{blobHash:'a'.repeat(64)}]);
  expect(resultExportRun(items)).toBe('run-1-selection');
  expect(resultExportRun([items[0]])).toBe('run-1');
});
