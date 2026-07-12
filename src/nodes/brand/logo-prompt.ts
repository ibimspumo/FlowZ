import { parseArtifact, type BrandBriefData, type ColorPaletteData } from "./artifacts";

function artifactData<T>(raw: string | undefined, kind: string): T | undefined {
  if (!raw) return;
  const parsed = parseArtifact(raw);
  return parsed.artifact === kind ? parsed.data as T : undefined;
}

export function buildLogoPrompt(inputs: { brief?: string; audience?: string; palette?: string; instruction?: string }): string {
  const brief = artifactData<BrandBriefData>(inputs.brief, "flowz.brand-brief");
  const palette = artifactData<ColorPaletteData>(inputs.palette, "flowz.color-palette");
  if (!brief) throw new Error("Verbinde ein Markenbriefing mit „Logo entwickeln“.");
  const audience = inputs.audience ? parseArtifact(inputs.audience) : undefined;
  return [
    "Entwickle ein eigenständiges, professionelles Markenlogo als klare Einzelmarke.",
    `Marke: ${brief.brandName || "noch ohne finalen Namen"}. Angebot: ${brief.offer}. Zielgruppe: ${brief.audience}.`,
    `Markenversprechen: ${brief.promise || "nicht festgelegt"}. Persönlichkeit: ${brief.personality.join(", ") || "präzise und klar"}.`,
    audience?.artifact === "flowz.audience-analysis" ? `Zielgruppenanalyse: ${JSON.stringify(audience.data)}` : "",
    palette ? `Verbindliche Farbrollen: ${palette.colors.map((entry) => `${entry.role} ${entry.hex}`).join(", ")}.` : "",
    String(inputs.instruction ?? "").trim().slice(0, 2000),
    "Nur das Logo, zentriert mit großzügiger Safe Area. Kein Mockup, keine Visitenkarte, keine Markenrechts- oder Einzigartigkeitsaussage.",
  ].filter(Boolean).join("\n\n");
}
