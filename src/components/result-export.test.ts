import {describe,expect,it} from 'vitest';
import {resultExportLabel} from './result-export';
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
