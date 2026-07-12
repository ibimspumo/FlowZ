export const FONT_MOODS = [
  "modern",
  "elegant",
  "editorial",
  "technical",
  "friendly",
  "luxury",
  "minimal",
  "playful",
  "bold",
] as const;
export type FontMood = (typeof FONT_MOODS)[number];
export type FontPairPreset = {
  id: string;
  name: string;
  mood: FontMood;
  headingFamily: string;
  bodyFamily: string;
  headingVariant: number;
  bodyVariant: number;
};

const PAIRS: Record<FontMood, readonly (readonly [string, string])[]> = {
  modern: [
    ["Space Grotesk", "Inter"],
    ["Manrope", "Source Sans 3"],
    ["Montserrat", "Lato"],
    ["Poppins", "Open Sans"],
    ["Barlow", "Roboto"],
    ["Raleway", "Work Sans"],
    ["Lexend", "Noto Sans"],
    ["Josefin Sans", "Karla"],
    ["Rubik", "Inter"],
    ["Archivo Black", "Manrope"],
    ["Oswald", "Source Sans 3"],
    ["IBM Plex Sans", "Inter"],
  ],
  elegant: [
    ["Playfair Display", "Source Sans 3"],
    ["Cormorant Garamond", "Lato"],
    ["Fraunces", "Inter"],
    ["DM Serif Display", "Manrope"],
    ["Libre Baskerville", "Open Sans"],
    ["Bodoni Moda", "Work Sans"],
    ["PT Serif", "PT Sans"],
    ["Merriweather", "Noto Sans"],
    ["Abril Fatface", "Karla"],
    ["Playfair Display", "Montserrat"],
    ["Cormorant Garamond", "Mulish"],
    ["Bitter", "Lato"],
  ],
  editorial: [
    ["Fraunces", "Source Sans 3"],
    ["Merriweather", "Inter"],
    ["Bitter", "Work Sans"],
    ["Roboto Slab", "Roboto"],
    ["Libre Baskerville", "Lato"],
    ["PT Serif", "PT Sans"],
    ["Playfair Display", "Open Sans"],
    ["DM Serif Display", "Karla"],
    ["Bodoni Moda", "Manrope"],
    ["Cormorant Garamond", "Noto Sans"],
    ["Abril Fatface", "Mulish"],
    ["Oswald", "Merriweather"],
  ],
  technical: [
    ["JetBrains Mono", "Inter"],
    ["IBM Plex Sans", "Source Sans 3"],
    ["Roboto Slab", "Roboto"],
    ["Space Grotesk", "Source Sans 3"],
    ["Barlow", "Noto Sans"],
    ["Lexend", "Inter"],
    ["Oswald", "Roboto"],
    ["Archivo Black", "Work Sans"],
    ["Rubik", "Open Sans"],
    ["Montserrat", "JetBrains Mono"],
    ["Manrope", "IBM Plex Sans"],
    ["Bitter", "Source Sans 3"],
  ],
  friendly: [
    ["Nunito", "Inter"],
    ["Quicksand", "Open Sans"],
    ["Rubik", "Lato"],
    ["Poppins", "Source Sans 3"],
    ["Fraunces", "Nunito"],
    ["Manrope", "Karla"],
    ["Lexend", "Noto Sans"],
    ["Bitter", "Mulish"],
    ["Raleway", "Nunito"],
    ["DM Serif Display", "Quicksand"],
    ["Josefin Sans", "Lato"],
    ["Barlow", "Open Sans"],
  ],
  luxury: [
    ["Bodoni Moda", "Manrope"],
    ["Cormorant Garamond", "Montserrat"],
    ["Playfair Display", "Lato"],
    ["DM Serif Display", "Inter"],
    ["Fraunces", "Work Sans"],
    ["Abril Fatface", "Karla"],
    ["Libre Baskerville", "Source Sans 3"],
    ["PT Serif", "Raleway"],
    ["Merriweather", "Mulish"],
    ["Bodoni Moda", "Noto Sans"],
    ["Cormorant Garamond", "Open Sans"],
    ["Playfair Display", "Josefin Sans"],
  ],
  minimal: [
    ["Inter", "Manrope"],
    ["Manrope", "Inter"],
    ["Work Sans", "Source Sans 3"],
    ["IBM Plex Sans", "Source Sans 3"],
    ["Noto Sans", "Inter"],
    ["Lato", "Open Sans"],
    ["Roboto", "Source Sans 3"],
    ["Karla", "Inter"],
    ["Barlow", "Source Sans 3"],
    ["Montserrat", "Open Sans"],
    ["Lexend", "Inter"],
    ["PT Sans", "Inter"],
  ],
  playful: [
    ["Quicksand", "Nunito"],
    ["Abril Fatface", "Karla"],
    ["Fraunces", "Inter"],
    ["Poppins", "Lato"],
    ["Rubik", "Open Sans"],
    ["Josefin Sans", "Mulish"],
    ["DM Serif Display", "Nunito"],
    ["Bitter", "Quicksand"],
    ["Archivo Black", "Karla"],
    ["Raleway", "Nunito"],
    ["Lexend", "Source Sans 3"],
    ["Oswald", "Poppins"],
  ],
  bold: [
    ["Archivo Black", "Inter"],
    ["Oswald", "Source Sans 3"],
    ["Abril Fatface", "Lato"],
    ["Space Grotesk", "Work Sans"],
    ["Montserrat", "Open Sans"],
    ["Roboto Slab", "Roboto"],
    ["DM Serif Display", "Manrope"],
    ["Bodoni Moda", "Karla"],
    ["Barlow", "Noto Sans"],
    ["Poppins", "Inter"],
    ["Fraunces", "Source Sans 3"],
    ["Bitter", "IBM Plex Sans"],
  ],
};

// Tiny startup metadata. The full 2 MB catalog is loaded only when the picker
// opens or a font workflow actually runs.
const NON_ZERO_DEFAULT_VARIANTS:Readonly<Record<string,number>>={Barlow:6,Lato:6,Poppins:6};
const defaultVariant=(family:string)=>NON_ZERO_DEFAULT_VARIANTS[family]??0;
const PRESET_FAMILIES=new Set(Object.values(PAIRS).flatMap((pairs)=>pairs.flatMap(([heading,body])=>[heading,body])));

export const FONT_PAIR_PRESETS: FontPairPreset[] = FONT_MOODS.flatMap((mood) =>
  PAIRS[mood].map(([headingFamily, bodyFamily], index) => ({
    id: `${mood}-${String(index + 1).padStart(2, "0")}`,
    name: `${headingFamily} + ${bodyFamily}`,
    mood,
    headingFamily,
    bodyFamily,
    headingVariant: defaultVariant(headingFamily),
    bodyVariant: defaultVariant(bodyFamily),
  })),
);
export function validateFontPairPreset(preset: FontPairPreset) {
  return FONT_MOODS.includes(preset.mood)&&preset.id===`${preset.mood}-${preset.id.slice(-2)}`&&PRESET_FAMILIES.has(preset.headingFamily)&&PRESET_FAMILIES.has(preset.bodyFamily)&&Number.isInteger(preset.headingVariant)&&Number.isInteger(preset.bodyVariant);
}
export function fontPresetForSeed(seed: number, excludeId?: string, mood?: FontMood) {
  const valid = FONT_PAIR_PRESETS.filter((preset) => preset.id !== excludeId && (!mood || preset.mood === mood));
  const normalized = Math.abs(Math.trunc(Number.isFinite(seed) ? seed : 0));
  return valid[normalized % valid.length];
}
export function fontPresetStyleHint(preset: FontPairPreset) {
  return `Typografie-Hinweis (visuelle Annäherung für Bildmodelle): ${preset.headingFamily} für markante Überschriften; ${preset.bodyFamily} für ruhigen Lesetext. Stimmung: ${preset.mood}. Schriftnamen sind gestalterische Referenzen, keine Garantie für exakte Glyphenwiedergabe.`;
}
