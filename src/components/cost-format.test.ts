import { describe,expect,it } from 'vitest';
import { formatCost } from './cost-format';
import { setLocale } from '../i18n';

describe('cost truthfulness',()=>{
  it('never formats estimates or unknown amounts as exact',()=>{
    setLocale('de');
    expect(formatCost(0.02,'estimated')).toContain('ca.');
    expect(formatCost(0.02,'estimated')).toContain('0,02');
    expect(formatCost(0.02,'unknown')).toBe('Unbekannt');
    expect(formatCost(0.02,'actual')).toContain('0,02');
    setLocale('en');expect(formatCost(0.02,'unknown')).toBe('Unknown');
    setLocale('de');
  });
});
