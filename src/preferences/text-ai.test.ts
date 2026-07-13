import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_TEXT_AI_SYSTEM_INSTRUCTION,getTextAiSystemInstruction,setTextAiSystemInstruction} from './text-ai';

describe('global text AI system instruction',()=>{
  it('uses the no-Em-Dash instruction by default and permits an intentional empty value',()=>{
    expect(getTextAiSystemInstruction({getItem:()=>null})).toBe(DEFAULT_TEXT_AI_SYSTEM_INSTRUCTION);
    const setItem=vi.fn(); expect(setTextAiSystemInstruction('',{setItem})).toBe(''); expect(setItem).toHaveBeenCalledWith('flowz:text-ai-system-instruction','');
    expect(getTextAiSystemInstruction({getItem:()=>''})).toBe('');
  });
});
