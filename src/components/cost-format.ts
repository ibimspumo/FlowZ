import { getLocale } from "../i18n";

type CostProvenance = "actual" | "estimated" | "unknown";

export function formatCost(
  value: number | undefined,
  provenance: CostProvenance = "actual",
) {
  const locale = getLocale();
  if (provenance === "unknown" || value === undefined)
    return locale === "de" ? "Unbekannt" : "Unknown";
  const formatted = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
  return provenance === "estimated"
    ? `${locale === "de" ? "ca." : "approx."} ${formatted}`
    : formatted;
}
