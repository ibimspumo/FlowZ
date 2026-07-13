export const DEFAULT_TEXT_AI_SYSTEM_INSTRUCTION = 'Verwende keine Gedankenstriche (Em Dashes). Nutze stattdessen normale Bindestriche, Kommas oder formuliere den Satz natürlich um.';
const STORAGE_KEY = 'flowz:text-ai-system-instruction';
const MAX_LENGTH = 8_000;

export function getTextAiSystemInstruction(storage: Pick<Storage,'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): string {
  if (!storage) return DEFAULT_TEXT_AI_SYSTEM_INSTRUCTION;
  try { const value=storage.getItem(STORAGE_KEY); return value === null ? DEFAULT_TEXT_AI_SYSTEM_INSTRUCTION : value.slice(0,MAX_LENGTH); }
  catch { return DEFAULT_TEXT_AI_SYSTEM_INSTRUCTION; }
}

export function setTextAiSystemInstruction(value: string, storage: Pick<Storage,'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): string {
  const bounded=value.slice(0,MAX_LENGTH); try { storage?.setItem(STORAGE_KEY,bounded); } catch { /* Preference storage must not block the settings UI. */ } return bounded;
}
