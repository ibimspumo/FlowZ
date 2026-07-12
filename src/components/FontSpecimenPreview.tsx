import { useEffect, useMemo, useState } from "react";
import { previewBrandFont } from "../api";
import type { FontPairingData, FontRecord } from "../nodes/brand/artifacts";
import { findFont } from "../nodes/brand/fonts";
import { useI18n } from "../i18n";
import { browserFontRegistry, type PreparedFont } from "./font-preview-loader";

type StoredFont = {
  family: string;
  variantIndex: number;
  axes: Record<string, number>;
  blobHash?: string;
  licenseBlobHash?: string;
  style?: string;
  weight?: number;
  license?: FontRecord["license"];
  subsets?: string[];
};

type Props = {
  heading: StoredFont;
  body: StoredFont;
  result?: FontPairingData;
  sample: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSampleChange: (sample: string) => void;
  onSampleCommit: () => void;
};

const preparedFrom = (font: FontRecord): PreparedFont | undefined =>
  font.blobHash
    ? {
        blobHash: font.blobHash,
        licenseBlobHash: font.licenseBlobHash,
        mediaUrl: `flowz-media://localhost/${font.blobHash}`,
      }
    : undefined;

function resolveFont(stored: StoredFont, result?: FontRecord): FontRecord {
  if (result) return result;
  const catalogFont = findFont(stored.family, stored.variantIndex, stored.axes);
  return {
    ...catalogFont,
    blobHash: stored.blobHash,
    licenseBlobHash: stored.licenseBlobHash,
    style: stored.style ?? catalogFont.style,
    weight: stored.weight ?? catalogFont.weight,
    license: stored.license ?? catalogFont.license,
    subsets: stored.subsets ?? catalogFont.subsets,
  };
}

const axisCss = (font: FontRecord) =>
  font.axisRanges
    .filter((axis) => axis.value != null)
    .map((axis) => `"${axis.tag}" ${axis.value}`)
    .join(", ");

export function FontSpecimenPreview({
  heading: storedHeading,
  body: storedBody,
  result,
  sample,
  expanded,
  onExpandedChange,
  onSampleChange,
  onSampleCommit,
}: Props) {
  const { t } = useI18n();
  const heading = useMemo(
    () => resolveFont(storedHeading, result?.heading),
    [storedHeading, result?.heading],
  );
  const body = useMemo(
    () => resolveFont(storedBody, result?.body),
    [storedBody, result?.body],
  );
  const [families, setFamilies] = useState<{ heading?: string; body?: string }>({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setError("");
    const load = async (role: "heading" | "body", font: FontRecord) => {
      const prepared = preparedFrom(font) ?? (await previewBrandFont(font));
      if (controller.signal.aborted) return;
      const key = `${font.family}:${font.variantIndex}`;
      const family = await browserFontRegistry.load(
        key,
        prepared,
        font.style,
        font.weight,
      );
      if (!controller.signal.aborted)
        setFamilies((current) => ({ ...current, [role]: family }));
    };
    void Promise.all([load("heading", heading), load("body", body)]).catch(
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => controller.abort();
  }, [expanded, heading, body]);

  const headingAxes = axisCss(heading);
  const bodyAxes = axisCss(body);
  return (
    <details
      className="font-specimen"
      open={expanded}
      onToggle={(event) => onExpandedChange(event.currentTarget.open)}
    >
      <summary>
        <span>
          <strong>{heading.family}</strong> + {body.family}
        </span>
        <small>{t("node.openSpecimen")}</small>
      </summary>
      <input
        className="font-specimen-copy nodrag nowheel nopan"
        aria-label={t("font.specimenLabel")}
        value={sample}
        onChange={(event) => onSampleChange(event.target.value)}
        onBlur={onSampleCommit}
      />
      {error && <p className="font-picker-error">{error}</p>}
      {!error && (!families.heading || !families.body) && (
        <p className="font-specimen-loading" role="status">
          {t("common.loading")}
        </p>
      )}
      <div
        className="font-specimen-display"
        style={{
          fontFamily: families.heading,
          fontWeight: heading.weight,
          fontStyle: heading.style,
          fontVariationSettings: headingAxes || undefined,
          visibility: families.heading ? "visible" : "hidden",
        }}
      >
        <h1>{sample}</h1>
        <h2>{t("node.specimenHierarchy")}</h2>
        <h3>{t("node.specimenPrecise")}</h3>
      </div>
      <div
        className="font-specimen-body"
        style={{
          fontFamily: families.body,
          fontWeight: body.weight,
          fontStyle: body.style,
          fontVariationSettings: bodyAxes || undefined,
          visibility: families.body ? "visible" : "hidden",
        }}
      >
        <p>{t("font.specimenBody")}</p>
        <ul>
          <li>{t("node.specimenSmall")}</li>
          <li>{t("node.specimenHeadings")}</li>
        </ul>
        <span className="font-specimen-button">{t("node.learnMore")}</span>
      </div>
      <dl className="font-role-facts">
        <div>
          <dt>{t("font.headingRole")}</dt>
          <dd>{heading.family} · {heading.style} {heading.weight} · {heading.license} · {heading.subsets.slice(0, 3).join(", ")}</dd>
        </div>
        <div>
          <dt>{t("node.readingText")}</dt>
          <dd>{body.family} · {body.style} {body.weight} · {body.license} · {body.subsets.slice(0, 3).join(", ")}</dd>
        </div>
      </dl>
    </details>
  );
}
