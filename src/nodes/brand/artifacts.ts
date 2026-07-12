export const BRAND_ARTIFACT_VERSION = 1 as const;

export type ArtifactEnvelope<T extends string, D> = {
  artifact: T;
  version: typeof BRAND_ARTIFACT_VERSION;
  id: string;
  createdAt: string;
  data: D;
};

export type BrandBriefData = {
  brandName: string;
  offer: string;
  audience: string;
  problem: string;
  promise: string;
  personality: string[];
  differentiators: string[];
  constraints: string[];
};
export type AudienceEvidence = { sourceId: string; url: string };
export type AudienceInsight = {
  statement: string;
  basis: "evidence" | "assumption";
  evidence?: AudienceEvidence;
};
export type AudienceAnalysisData = {
  summary: string;
  jobs: AudienceInsight[];
  pains: AudienceInsight[];
  gains: AudienceInsight[];
  questions: string[];
};
export type NameCandidate = {
  id: string;
  name: string;
  rationale: string;
  domainSlug: string;
  trademarkChecked: false;
};
export type NameCandidateListData = {
  candidates: NameCandidate[];
  iteration: number;
};
export type DomainStatus =
  | "registered"
  | "not-found"
  | "unknown"
  | "rate-limited"
  | "unsupported"
  | "invalid";
export type DomainCheck = {
  domain: string;
  unicodeDomain: string;
  tld: string;
  status: DomainStatus;
  checkedAt: string;
  rdapUrl?: string;
  note: string;
};
export type DomainAvailabilityData = {
  consentedAt: string;
  checks: DomainCheck[];
  disclaimer: string;
};
export type HandleLink = {
  platform: string;
  handle: string;
  validSyntax: boolean;
  profileUrl: string;
  signupUrl: string;
  note: string;
};
export type HandlePlanData = {
  handle: string;
  links: HandleLink[];
  disclaimer: string;
};
export type FontAxis = {
  tag: string;
  min: number;
  max: number;
  value?: number;
};
export type FontVariant = {
  style: string;
  weight: number;
  file: string;
  variable: boolean;
  url: string;
};
export type FontRecord = {
  family: string;
  category: "sans-serif" | "serif" | "display" | "monospace" | "handwriting";
  license: "OFL-1.1" | "Apache-2.0" | "UFL-1.0";
  source: string;
  path: string;
  metadataUrl: string;
  metadataSha256: string;
  licenseUrl: string;
  licenseSha256: string;
  fontUrl: string;
  fontSha256?: string;
  fontFile: string;
  style: string;
  weight: number;
  axes: string[];
  axisRanges: FontAxis[];
  variants: FontVariant[];
  variantIndex: number;
  subsets: string[];
  blobHash?: string;
  licenseBlobHash?: string;
};
export type FontPairingData = {
  heading: FontRecord;
  body: FontRecord;
  rationale: string;
};
export type PaletteColor = {
  role: "primary" | "secondary" | "accent" | "background" | "surface" | "text";
  hex: string;
};
export type ColorPaletteData = {
  colors: PaletteColor[];
  contrast: {
    foreground: string;
    background: string;
    ratio: number;
    aaNormal: boolean;
    aaLarge: boolean;
  }[];
};

const id = () => crypto.randomUUID();
export function artifact<T extends string, D>(
  kind: T,
  data: D,
  createdAt = new Date().toISOString(),
): ArtifactEnvelope<T, D> {
  return {
    artifact: kind,
    version: BRAND_ARTIFACT_VERSION,
    id: id(),
    createdAt,
    data,
  };
}

export function stableNameId(name: string): string {
  let hash = 2166136261;
  for (const char of name.normalize("NFKC").toLocaleLowerCase("de-DE")) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return `name-${(hash >>> 0).toString(36)}`;
}

export function domainSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 63);
}

export function normalizeNameCandidates(
  value: unknown,
  iteration: number,
  requestedCount?: number,
): NameCandidateListData {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { candidates?: unknown }).candidates)
  )
    throw new Error("Die Namensantwort enthält keine Kandidatenliste.");
  const seen = new Set<string>();
  const candidates = (value as { candidates: unknown[] }).candidates.flatMap(
    (raw) => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as Record<string, unknown>;
      const name = String(candidate.name ?? "").trim();
      const slug = domainSlug(String(candidate.domainSlug ?? name));
      if (!name || !slug || seen.has(name.toLocaleLowerCase("de-DE")))
        return [];
      seen.add(name.toLocaleLowerCase("de-DE"));
      return [
        {
          id: stableNameId(name),
          name,
          rationale: String(candidate.rationale ?? "").trim(),
          domainSlug: slug,
          trademarkChecked: false as const,
        },
      ];
    },
  );
  if (!candidates.length || candidates.length > 20)
    throw new Error(
      "Die Namensantwort muss 1 bis 20 gültige Kandidaten enthalten.",
    );
  if (requestedCount !== undefined && candidates.length !== requestedCount)
    throw new Error(
      `Das Modell lieferte ${candidates.length} statt exakt ${requestedCount} eindeutigen Namen.`,
    );
  return { candidates, iteration };
}

function channel(hex: string, offset: number) {
  const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function normalizeHex(hex: string): string {
  const v = hex.trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(v))
    throw new Error(`Ungültige sRGB-Farbe: ${hex}`);
  return v;
}
export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) =>
    0.2126 * channel(normalizeHex(hex), 1) +
    0.7152 * channel(normalizeHex(hex), 3) +
    0.0722 * channel(normalizeHex(hex), 5);
  const [a, b] = [luminance(foreground), luminance(background)].sort(
    (x, y) => y - x,
  );
  return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
}
export function buildContrastMatrix(
  colors: PaletteColor[],
): ColorPaletteData["contrast"] {
  return colors.flatMap((foreground, index) =>
    colors.slice(index + 1).map((background) => {
      const ratio = contrastRatio(foreground.hex, background.hex);
      return {
        foreground: foreground.role,
        background: background.role,
        ratio,
        aaNormal: ratio >= 4.5,
        aaLarge: ratio >= 3,
      };
    }),
  );
}

export const RECOMMENDED_TLDS = [
  "com",
  "de",
  "io",
  "co",
  "ai",
  "app",
  "dev",
  "design",
  "studio",
  "agency",
  "digital",
  "media",
  "tech",
  "tools",
  "software",
  "cloud",
  "xyz",
  "net",
  "org",
  "eu",
] as const;

const HANDLE_PLATFORMS = [
  [
    "Instagram",
    "https://www.instagram.com/{h}/",
    "https://www.instagram.com/accounts/emailsignup/",
  ],
  ["TikTok", "https://www.tiktok.com/@{h}", "https://www.tiktok.com/signup"],
  [
    "YouTube",
    "https://www.youtube.com/@{h}",
    "https://www.youtube.com/create_channel",
  ],
  ["X", "https://x.com/{h}", "https://x.com/i/flow/signup"],
  [
    "Facebook",
    "https://www.facebook.com/{h}",
    "https://www.facebook.com/pages/create/",
  ],
  [
    "LinkedIn",
    "https://www.linkedin.com/company/{h}",
    "https://www.linkedin.com/company/setup/new/",
  ],
] as const;
export function buildHandlePlan(input: string): HandlePlanData {
  const handle = input.trim().replace(/^@/, "");
  const validSyntax = /^[A-Za-z0-9._-]{2,30}$/.test(handle);
  return {
    handle,
    links: HANDLE_PLATFORMS.map(([platform, profile, signup]) => ({
      platform,
      handle,
      validSyntax,
      profileUrl: profile.replace("{h}", encodeURIComponent(handle)),
      signupUrl: signup,
      note: validSyntax
        ? "Profil manuell prüfen; keine Verfügbarkeitsaussage."
        : "Syntax ist nicht plattformübergreifend sicher.",
    })),
    disclaimer:
      "FlowZ prüft keine Username-Verfügbarkeit und scrapt keine Plattform. Links dienen ausschließlich der manuellen Prüfung.",
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => key in value);
const text = (value: unknown, max = 4000) =>
  typeof value === "string" && value.length <= max;
const strings = (value: unknown, maxItems = 20, maxLength = 500) =>
  Array.isArray(value) &&
  value.length <= maxItems &&
  value.every((item) => text(item, maxLength));
const hash = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const url = (value: unknown) => {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export function validateArtifactEnvelope(
  value: unknown,
): value is ArtifactEnvelope<string, unknown> {
  if (
    !record(value) ||
    !exact(value, ["artifact", "version", "id", "createdAt", "data"]) ||
    value.version !== 1 ||
    !text(value.artifact, 80) ||
    !text(value.id, 100) ||
    !text(value.createdAt, 40) ||
    Number.isNaN(Date.parse(String(value.createdAt))) ||
    !record(value.data)
  )
    return false;
  const d = value.data;
  if (value.artifact === "flowz.brand-brief")
    return (
      exact(d, [
        "brandName",
        "offer",
        "audience",
        "problem",
        "promise",
        "personality",
        "differentiators",
        "constraints",
      ]) &&
      [d.brandName, d.offer, d.audience, d.problem, d.promise].every((v) =>
        text(v, 2000),
      ) &&
      strings(d.personality, 12, 100) &&
      strings(d.differentiators, 20, 500) &&
      strings(d.constraints, 20, 500)
    );
  if (value.artifact === "flowz.audience-analysis") {
    const insight = (v: unknown) =>
      record(v) &&
      Object.keys(v).every((k) =>
        ["statement", "basis", "evidence"].includes(k),
      ) &&
      text(v.statement, 1000) &&
      ["evidence", "assumption"].includes(String(v.basis)) &&
      (v.basis === "assumption"
        ? v.evidence === undefined
        : record(v.evidence) &&
          exact(v.evidence, ["sourceId", "url"]) &&
          text(v.evidence.sourceId, 80) &&
          url(v.evidence.url));
    return (
      exact(d, ["summary", "jobs", "pains", "gains", "questions"]) &&
      text(d.summary, 4000) &&
      ["jobs", "pains", "gains"].every(
        (k) =>
          Array.isArray(d[k]) &&
          (d[k] as unknown[]).length <= 8 &&
          (d[k] as unknown[]).every(insight),
      ) &&
      strings(d.questions, 8, 1000)
    );
  }
  if (value.artifact === "flowz.name-candidate-list")
    return (
      exact(d, ["candidates", "iteration"]) &&
      Number.isInteger(d.iteration) &&
      Number(d.iteration) >= 0 &&
      Array.isArray(d.candidates) &&
      d.candidates.length >= 1 &&
      d.candidates.length <= 20 &&
      new Set(d.candidates.map((v) => (record(v) ? v.id : ""))).size ===
        d.candidates.length &&
      d.candidates.every(
        (v) =>
          record(v) &&
          exact(v, [
            "id",
            "name",
            "rationale",
            "domainSlug",
            "trademarkChecked",
          ]) &&
          text(v.id, 80) &&
          text(v.name, 100) &&
          text(v.rationale, 1000) &&
          typeof v.domainSlug === "string" &&
          domainSlug(v.domainSlug) === v.domainSlug &&
          v.trademarkChecked === false,
      )
    );
  if (value.artifact === "flowz.domain-availability")
    return (
      exact(d, ["consentedAt", "checks", "disclaimer"]) &&
      text(d.consentedAt, 40) &&
      Array.isArray(d.checks) &&
      d.checks.length <= 20 &&
      d.checks.every(
        (v) =>
          record(v) &&
          Object.keys(v).every((k) =>
            [
              "domain",
              "unicodeDomain",
              "tld",
              "status",
              "checkedAt",
              "rdapUrl",
              "note",
            ].includes(k),
          ) &&
          [v.domain, v.unicodeDomain, v.tld, v.checkedAt, v.note].every((x) =>
            text(x, 1000),
          ) &&
          [
            "registered",
            "not-found",
            "unknown",
            "rate-limited",
            "unsupported",
            "invalid",
          ].includes(String(v.status)) &&
          (v.rdapUrl === undefined || url(v.rdapUrl)),
      ) &&
      text(d.disclaimer, 2000)
    );
  if (value.artifact === "flowz.handle-plan")
    return (
      exact(d, ["handle", "links", "disclaimer"]) &&
      text(d.handle, 100) &&
      Array.isArray(d.links) &&
      d.links.length <= 12 &&
      d.links.every(
        (v) =>
          record(v) &&
          exact(v, [
            "platform",
            "handle",
            "validSyntax",
            "profileUrl",
            "signupUrl",
            "note",
          ]) &&
          text(v.platform, 100) &&
          text(v.handle, 100) &&
          typeof v.validSyntax === "boolean" &&
          url(v.profileUrl) &&
          url(v.signupUrl) &&
          text(v.note, 500),
      ) &&
      text(d.disclaimer, 1000)
    );
  if (value.artifact === "flowz.font-pairing") {
    const font = (v: unknown) =>
      record(v) &&
      [
        "family",
        "category",
        "license",
        "source",
        "path",
        "metadataUrl",
        "metadataSha256",
        "licenseUrl",
        "licenseSha256",
        "fontUrl",
        "fontFile",
        "style",
        "weight",
        "axes",
        "axisRanges",
        "variants",
        "variantIndex",
        "subsets",
      ].every((k) => k in v) &&
      text(v.family, 100) &&
      ["sans-serif", "serif", "display", "monospace", "handwriting"].includes(
        String(v.category),
      ) &&
      ["OFL-1.1", "Apache-2.0", "UFL-1.0"].includes(String(v.license)) &&
      [v.source, v.metadataUrl, v.licenseUrl, v.fontUrl].every(url) &&
      [v.metadataSha256, v.licenseSha256].every(hash) &&
      (v.fontSha256 === undefined || hash(v.fontSha256)) &&
      strings(v.axes, 32, 10) &&
      strings(v.subsets, 80, 30) &&
      Array.isArray(v.axisRanges) &&
      v.axisRanges.length <= 32 &&
      Array.isArray(v.variants) &&
      v.variants.length <= 64 &&
      Number.isInteger(v.variantIndex) &&
      (v.blobHash === undefined || hash(v.blobHash)) &&
      (v.licenseBlobHash === undefined || hash(v.licenseBlobHash));
    return (
      exact(d, ["heading", "body", "rationale"]) &&
      font(d.heading) &&
      font(d.body) &&
      text(d.rationale, 2000)
    );
  }
  if (value.artifact === "flowz.color-palette")
    return (
      exact(d, ["colors", "contrast"]) &&
      Array.isArray(d.colors) &&
      d.colors.length >= 4 &&
      d.colors.length <= 6 &&
      new Set(d.colors.map((v) => (record(v) ? v.role : ""))).size ===
        d.colors.length &&
      d.colors.every(
        (v) =>
          record(v) &&
          exact(v, ["role", "hex"]) &&
          [
            "primary",
            "secondary",
            "accent",
            "background",
            "surface",
            "text",
          ].includes(String(v.role)) &&
          typeof v.hex === "string" &&
          /^#[0-9A-F]{6}$/.test(v.hex),
      ) &&
      Array.isArray(d.contrast) &&
      d.contrast.length === (d.colors.length * (d.colors.length - 1)) / 2
    );
  return false;
}
export function parseArtifact(
  value: string,
): ArtifactEnvelope<string, unknown> {
  const parsed = JSON.parse(value);
  if (!validateArtifactEnvelope(parsed))
    throw new Error(
      "Kein gültiges oder vollständig validiertes FlowZ-Brand-Artefakt.",
    );
  return parsed;
}
