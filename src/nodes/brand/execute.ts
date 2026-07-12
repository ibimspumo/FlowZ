import {
  checkBrandDomains,
  prepareBrandFont,
  runStructuredChat,
} from "../../api";
import type { FlowNodeData, NodeKind } from "../../types";
import {
  artifact,
  buildContrastMatrix,
  buildHandlePlan,
  domainSlug,
  normalizeHex,
  normalizeNameCandidates,
  parseArtifact,
  RECOMMENDED_TLDS,
  stableNameId,
  type AudienceAnalysisData,
  type BrandBriefData,
  type ColorPaletteData,
  type DomainAvailabilityData,
  type FontPairingData,
  type PaletteColor,
} from "./artifacts";
import {
  FONT_PAIR_PRESETS,
  fontPresetForSeed,
  fontPresetStyleHint,
  validateFontPairPreset,
} from "./font-presets";
import { audienceSchema, namesSchema, paletteSchema } from "./schemas";

export type BrandExecution = {
  value: string;
  output: string;
  outputs?: Record<string, string>;
  costMicrounits?: number;
  parameters: Record<string, string | number | boolean>;
};
type Inputs = Readonly<Record<string, readonly string[]>>;
const splitLines = (value: unknown) =>
  String(value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
const inputArtifact = (inputs: Inputs, port: string) => {
  const value = inputs[port]?.[0];
  return value ? parseArtifact(value) : undefined;
};
const encoded = (kind: string, data: unknown) =>
  JSON.stringify(artifact(kind, data));

function briefFrom(data: FlowNodeData): BrandBriefData {
  const brief = {
    brandName: String(data.brandName ?? "").trim(),
    offer: String(data.offer ?? "").trim(),
    audience: String(data.audience ?? "").trim(),
    problem: String(data.problem ?? "").trim(),
    promise: String(data.promise ?? "").trim(),
    personality: splitLines(data.personality),
    differentiators: splitLines(data.differentiators),
    constraints: splitLines(data.constraints),
  };
  if (!brief.offer || !brief.audience)
    throw new Error(
      "Angebot und Zielgruppe werden für ein belastbares Briefing benötigt.",
    );
  return brief;
}

function researchSources(markdown: string) {
  const urls = [...markdown.matchAll(/https:\/\/[^\s)>\]]+/g)].map((match) =>
    match[0].replace(/[.,;:]$/, ""),
  );
  return [...new Set(urls)]
    .slice(0, 30)
    .map((url) => ({ sourceId: `source-${stableNameId(url).slice(5)}`, url }));
}
function normalizeAudience(
  raw: unknown,
  sources: readonly { sourceId: string; url: string }[],
): AudienceAnalysisData {
  if (!raw || typeof raw !== "object")
    throw new Error("Ungültige Zielgruppenanalyse.");
  const item = raw as Record<string, unknown>;
  const insights = (key: string) => {
    if (!Array.isArray(item[key]))
      throw new Error(`Zielgruppenfeld ${key} fehlt.`);
    return item[key]
      .map((raw) => {
        const value = raw as Record<string, unknown>;
        const matched =
          typeof value.evidenceSourceId === "string"
            ? sources.find(
                (source) => source.sourceId === value.evidenceSourceId,
              )
            : undefined;
        const basis: "evidence" | "assumption" =
          value.basis === "evidence" && Boolean(matched)
            ? "evidence"
            : "assumption";
        return {
          statement: String(value.statement ?? "").trim(),
          basis,
          ...(basis === "evidence" && matched ? { evidence: matched } : {}),
        };
      })
      .filter((v) => v.statement);
  };
  return {
    summary: String(item.summary ?? "").trim(),
    jobs: insights("jobs"),
    pains: insights("pains"),
    gains: insights("gains"),
    questions: Array.isArray(item.questions)
      ? item.questions.map(String).filter(Boolean)
      : [],
  };
}

export async function executeBrandNode(
  kind: NodeKind,
  data: FlowNodeData,
  inputs: Inputs,
): Promise<BrandExecution> {
  if (kind === "brandBrief") {
    const value = encoded("flowz.brand-brief", briefFrom(data));
    return { value, output: "brief", parameters: { artifactVersion: 1 } };
  }
  if (kind === "audienceAnalysis") {
    const brief = inputArtifact(inputs, "brief");
    if (brief?.artifact !== "flowz.brand-brief")
      throw new Error("Verbinde ein Markenbriefing.");
    const research = (inputs.research ?? []).join("\n\n");
    const sources = researchSources(research);
    const prompt = `Analysiere die Zielgruppe auf Deutsch. Trenne belegte Erkenntnisse strikt von Annahmen. evidence ist nur erlaubt, wenn evidenceSourceId exakt aus der Quellenliste stammt; sonst basis assumption und evidenceSourceId null.\nBriefing: ${JSON.stringify(brief.data)}\nQuellenliste: ${JSON.stringify(sources)}\nRecherchetext: ${research || "(keine)"}\nZusatz: ${String(data.prompt ?? "")}`;
    const result = await runStructuredChat(
      String(data.model),
      prompt,
      "flowz_audience_analysis",
      audienceSchema as unknown as Record<string, unknown>,
    );
    const parsed = normalizeAudience(JSON.parse(result.content ?? ""), sources);
    const value = encoded("flowz.audience-analysis", parsed);
    return {
      value,
      output: "audience",
      costMicrounits: result.costMicrounits,
      parameters: {
        artifactVersion: 1,
        evidenceCount: [
          ...parsed.jobs,
          ...parsed.pains,
          ...parsed.gains,
        ].filter((i) => i.basis === "evidence").length,
      },
    };
  }
  if (kind === "brandNames") {
    const brief = inputArtifact(inputs, "brief");
    if (brief?.artifact !== "flowz.brand-brief")
      throw new Error("Verbinde ein Markenbriefing.");
    const audience = inputArtifact(inputs, "audience");
    const count = Math.max(1, Math.min(20, Number(data.candidateCount ?? 8)));
    const iteration = Number(data.iteration ?? 0);
    const prompt = `Erzeuge exakt ${count} eigenständige Markennamen auf Basis der Daten. Keine Verfügbarkeits- oder Markenrechtsbehauptungen. domainSlug muss ein ASCII-DNS-Label ohne TLD sein. Iteration ${iteration}.\nBriefing: ${JSON.stringify(brief.data)}\nZielgruppe: ${JSON.stringify(audience?.data ?? null)}\nZusatz: ${String(data.prompt ?? "")}`;
    const result = await runStructuredChat(
      String(data.model),
      prompt,
      "flowz_name_candidates",
      namesSchema as unknown as Record<string, unknown>,
    );
    const normalized = normalizeNameCandidates(
      JSON.parse(result.content ?? ""),
      iteration,
      count,
    );
    const value = encoded("flowz.name-candidate-list", normalized);
    return {
      value,
      output: "names",
      costMicrounits: result.costMicrounits,
      parameters: {
        artifactVersion: 1,
        iteration,
        candidates: normalized.candidates.length,
      },
    };
  }
  if (kind === "domainCheck") {
    const names = inputArtifact(inputs, "names");
    if (names && names.artifact !== "flowz.name-candidate-list")
      throw new Error("Der verbundene Eingang ist keine strukturierte Namensliste.");
    const candidates =
      ((names?.data as
        | { candidates?: { id: string; domainSlug: string }[] }
        | undefined)?.candidates ?? []);
    const selected = data.selectedNameId
      ? candidates.find((candidate) => candidate.id === data.selectedNameId)
      : candidates[0];
    const directSlug = domainSlug(String(data.domainName ?? ""));
    if (!directSlug && data.selectedNameId && !selected)
      throw new Error(
        "Der ausgewählte Name gehört nicht mehr zur verbundenen Namensrunde. Wähle einen aktuellen Kandidaten.",
      );
    const checkedSlug = directSlug || selected?.domainSlug;
    if (!checkedSlug)
      throw new Error(
        "Gib einen Namen direkt ein oder verbinde eine strukturierte Namensliste.",
      );
    const tlds = (data.tlds?.length ? data.tlds : [...RECOMMENDED_TLDS]).slice(
      0,
      20,
    );
    const checks = await checkBrandDomains(
      [checkedSlug],
      tlds,
      Boolean(data.privacyConsent),
    );
    const payload: DomainAvailabilityData = {
      consentedAt: new Date().toISOString(),
      checks,
      disclaimer:
        "RDAP „not-found“ bedeutet nur: zum Prüfzeitpunkt kein Datensatz gefunden. Es ist niemals eine Registrierungs- oder Kaufgarantie.",
    };
    const value = encoded("flowz.domain-availability", payload);
    return {
      value,
      output: "domains",
      parameters: {
        artifactVersion: 1,
        checks: checks.length,
        checkedAt: payload.consentedAt,
        source: directSlug ? "direct-override" : "connected-name",
      },
    };
  }
  if (kind === "handlePlan") {
    const names = inputArtifact(inputs, "names");
    const candidates =
      (
        names?.data as
          | { candidates?: { id: string; domainSlug: string }[] }
          | undefined
      )?.candidates ?? [];
    const selected = data.selectedNameId
      ? candidates.find((candidate) => candidate.id === data.selectedNameId)
      : candidates[0];
    if (data.selectedNameId && !selected)
      throw new Error(
        "Der ausgewählte Name gehört nicht mehr zur verbundenen Namensrunde.",
      );
    const handle =
      String(data.handle ?? "").trim() || selected?.domainSlug || "";
    if (!handle)
      throw new Error("Trage einen Handle ein oder verbinde eine Namensliste.");
    const value = encoded("flowz.handle-plan", buildHandlePlan(handle));
    return {
      value,
      output: "handles",
      parameters: { artifactVersion: 1, availabilityChecked: false },
    };
  }
  if (kind === "fontPairing") {
    const {findFont,validateFontRecord}=await import("./fonts");
    const brief = inputArtifact(inputs, "brief"),
      audience = inputArtifact(inputs, "audience");
    const seeded=fontPresetForSeed(Number(data.fontPresetSeed??0));
    let preset = data.headingFont&&data.bodyFont?{
      id:'custom',name:`${data.headingFont} + ${data.bodyFont}`,mood:(FONT_PAIR_PRESETS.find(item=>item.mood===data.fontMood)?.mood??seeded.mood),
      headingFamily:String(data.headingFont),bodyFamily:String(data.bodyFont),headingVariant:Number(data.headingFontVariant??0),bodyVariant:Number(data.bodyFontVariant??0),
    }:seeded;
    let rationale = `${preset.headingFamily} setzt markante Überschriften; ${preset.bodyFamily} hält längere Inhalte ruhig und lesbar.`;
    let costMicrounits: number | undefined;
    if (brief || audience) {
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["presetId", "rationale"],
        properties: {
          presetId: {
            type: "string",
            enum: FONT_PAIR_PRESETS.map((item) => item.id),
          },
          rationale: { type: "string", minLength: 20, maxLength: 1200 },
        },
      };
      const result = await runStructuredChat(
        String(data.model),
        `Wähle exakt eine der validierten Typografie-Vorlagen. Erfinde keine Schriften, IDs oder Verfügbarkeiten. Begründe die Rollen knapp auf Deutsch.\nVorlagen: ${JSON.stringify(FONT_PAIR_PRESETS.map((item) => ({ id: item.id, mood: item.mood, heading: item.headingFamily, body: item.bodyFamily })))}\nBriefing: ${JSON.stringify(brief?.data ?? null)}\nZielgruppe: ${JSON.stringify(audience?.data ?? null)}`,
        "flowz_font_pairing_preset",
        schema,
      );
      const choice = JSON.parse(result.content ?? "") as {
        presetId?: string;
        rationale?: string;
      };
      const selected = FONT_PAIR_PRESETS.find(
        (item) => item.id === choice.presetId,
      );
      if (!selected || !validateFontPairPreset(selected))
        throw new Error(
          "Das Modell hat keine freigegebene Font-Pairing-Vorlage gewählt.",
        );
      preset = selected;
      rationale = String(choice.rationale ?? "").trim();
      costMicrounits = result.costMicrounits;
    }
    const heading = findFont(
        preset.headingFamily,
        preset.headingVariant,
        (data.headingFontAxes ?? {}) as Record<string, number>,
      ),
      body = findFont(
        preset.bodyFamily,
        preset.bodyVariant,
        (data.bodyFontAxes ?? {}) as Record<string, number>,
      );
    if(heading.family===body.family)throw new Error('Wähle zwei unterschiedliche Schriften.');
    if (!validateFontRecord(heading) || !validateFontRecord(body))
      throw new Error(
        "Eine Schrift hat keine gültige gepinnte Quelle oder Lizenz.",
      );
    const [headingPrepared, bodyPrepared] = await Promise.all([
      prepareBrandFont(heading),
      prepareBrandFont(body),
    ]);
    const payload: FontPairingData = {
      heading: {
        ...heading,
        fontSha256: headingPrepared.fontSha256,
        blobHash: headingPrepared.blobHash,
        licenseBlobHash: headingPrepared.licenseBlobHash,
      },
      body: {
        ...body,
        fontSha256: bodyPrepared.fontSha256,
        blobHash: bodyPrepared.blobHash,
        licenseBlobHash: bodyPrepared.licenseBlobHash,
      },
      rationale,
    };
    const value = encoded("flowz.font-pairing", payload),
      styleHint = fontPresetStyleHint(preset);
    return {
      value,
      output: "pairing",
      outputs: { pairing: value, styleHint },
      costMicrounits,
      parameters: {
        artifactVersion: 1,
        presetId: preset.id,
        catalogCommit: heading.source.split("/tree/")[1]?.split("/")[0] ?? "",
        headingFontHash: headingPrepared.blobHash,
        bodyFontHash: bodyPrepared.blobHash,
      },
    };
  }
  if (kind === "colorPalette") {
    const brief = inputArtifact(inputs, "brief");
    if (brief?.artifact !== "flowz.brand-brief")
      throw new Error("Verbinde ein Markenbriefing.");
    const audience = inputArtifact(inputs, "audience");
    const prompt = `Erzeuge eine präzise sRGB-Markenpalette. Jede Rolle höchstens einmal, Hintergrund und Text müssen enthalten sein. Nur #RRGGBB.\nBriefing: ${JSON.stringify(brief.data)}\nZielgruppe: ${JSON.stringify(audience?.data ?? null)}\nRichtung: ${String(data.paletteDirection ?? "")}`;
    const result = await runStructuredChat(
      String(data.model),
      prompt,
      "flowz_color_palette",
      paletteSchema as unknown as Record<string, unknown>,
    );
    const raw = JSON.parse(result.content ?? "") as { colors?: PaletteColor[] };
    if (!Array.isArray(raw.colors))
      throw new Error("Die Farbantwort enthält keine Palette.");
    const colors = raw.colors.map((c) => ({
      role: c.role,
      hex: normalizeHex(c.hex),
    }));
    if (new Set(colors.map((c) => c.role)).size !== colors.length)
      throw new Error("Die Farbantwort enthält doppelte Rollen.");
    if (
      !colors.some((c) => c.role === "background") ||
      !colors.some((c) => c.role === "text")
    )
      throw new Error("Palette braucht Hintergrund und Text.");
    const payload: ColorPaletteData = {
      colors,
      contrast: buildContrastMatrix(colors),
    };
    const value = encoded("flowz.color-palette", payload);
    return {
      value,
      output: "palette",
      costMicrounits: result.costMicrounits,
      parameters: { artifactVersion: 1, colors: colors.length },
    };
  }
  throw new Error(`Keine Brand-Ausführung für ${kind}.`);
}

export const BRAND_NODE_KINDS = new Set<NodeKind>([
  "brandBrief",
  "audienceAnalysis",
  "brandNames",
  "domainCheck",
  "handlePlan",
  "fontPairing",
  "colorPalette",
]);
