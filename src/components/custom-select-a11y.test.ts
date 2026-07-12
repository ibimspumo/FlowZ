import {describe,expect,it} from 'vitest';
import {customSelectOptionId} from './CustomSelect';

describe('CustomSelect active descendant ids',()=>{
  it('creates stable unique option ids for aria-activedescendant',()=>{
    expect(customSelectOptionId(':r3:',0)).toBe(':r3:-option-0');
    expect(customSelectOptionId(':r3:',1)).not.toBe(customSelectOptionId(':r3:',0));
    expect(customSelectOptionId(':r4:',0)).not.toBe(customSelectOptionId(':r3:',0));
  });
});
