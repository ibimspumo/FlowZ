export type ImageTransformRecipe = {
  mode: 'fit' | 'fill' | 'free'; targetWidth: number; targetHeight: number; noUpscale: boolean;
  outputFormat: 'png' | 'jpeg' | 'webp'; quality: number; background: string;
  cropX: number; cropY: number; cropWidth: number; cropHeight: number;
};

export const ASPECT_RATIOS: Record<string, number | undefined> = { original: undefined, '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4, custom: undefined };

export function applyAspectFromWidth(width: number, aspect: string): number | undefined {
  const ratio = ASPECT_RATIOS[aspect]; return ratio ? Math.max(1, Math.round(width / ratio)) : undefined;
}
export function applyAspectFromHeight(height: number, aspect: string): number | undefined {
  const ratio = ASPECT_RATIOS[aspect]; return ratio ? Math.max(1, Math.round(height * ratio)) : undefined;
}
export function validateImageTransform(recipe: ImageTransformRecipe): string[] {
  const errors: string[] = []; const pixels = recipe.targetWidth * recipe.targetHeight;
  if (!Number.isInteger(recipe.targetWidth) || !Number.isInteger(recipe.targetHeight) || recipe.targetWidth < 1 || recipe.targetHeight < 1 || pixels > 64_000_000) errors.push('Zielgröße: ganze Werte bis insgesamt 64 MP.');
  if (!['fit','fill','free'].includes(recipe.mode)) errors.push('Unbekannter Modus.');
  if (!['png','jpeg','webp'].includes(recipe.outputFormat)) errors.push('Ungültiges Dateiformat.');
  if (!Number.isInteger(recipe.quality) || recipe.quality < 1 || recipe.quality > 100) errors.push('JPEG-Qualität: 1–100.');
  if (!/^#[0-9a-f]{6}$/i.test(recipe.background)) errors.push('Hintergrund: #RRGGBB.');
  const crop = [recipe.cropX,recipe.cropY,recipe.cropWidth,recipe.cropHeight];
  if (crop.some((value) => !Number.isFinite(value)) || recipe.cropX < 0 || recipe.cropY < 0 || recipe.cropWidth <= 0 || recipe.cropHeight <= 0 || recipe.cropX + recipe.cropWidth > 1.000001 || recipe.cropY + recipe.cropHeight > 1.000001) errors.push('Der freie Zuschnitt muss im Bild liegen.');
  return errors;
}
