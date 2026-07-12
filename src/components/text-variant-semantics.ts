export type TextVariantMode = 'map' | 'aggregate';

type PromptParts = {
  instruction: string;
  scalarInputs: readonly string[];
  variants?: readonly string[];
  mode?: TextVariantMode;
  variantIndex?: number;
};

/**
 * Preserve the distinction between ordinary connected context and deliberate
 * sibling results. Labels make ordering unambiguous to the model without
 * leaking the implementation terms "textList", Map, or Aggregate to users.
 */
export function composeTextPrompt({
  instruction,
  scalarInputs,
  variants = [],
  mode = 'aggregate',
  variantIndex = 0,
}: PromptParts): string {
  const context = scalarInputs.map((value) => value.trim()).filter(Boolean);
  const material = variants.map((value) => value.trim()).filter(Boolean);
  const variantBlock = material.length === 0
    ? ''
    : mode === 'map'
      ? `Aktuelle Variante ${variantIndex + 1} von ${material.length}:\n${material[variantIndex] ?? ''}`
      : `Varianten in fester Reihenfolge:\n${material.map((value, index) => `--- Variante ${index + 1} ---\n${value}`).join('\n')}`;
  return [...context, variantBlock, instruction.trim()].filter(Boolean).join('\n\n');
}

export function assertTextVariantSourceReady(
  connected: boolean,
  variants: readonly string[],
): void {
  if (connected && variants.length === 0)
    throw new Error(
      'Die verbundene Variantenquelle hat noch keine Ergebnisse. Führe sie zuerst aus oder löse die Verbindung.',
    );
}
