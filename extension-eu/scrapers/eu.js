/**
 * EU member states + UK. Used to keep fully remote roles that can be
 * worked from those countries.
 */

export const EU_UK_COUNTRIES = [
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czech Republic",
  "Czechia",
  "Denmark",
  "Estonia",
  "Finland",
  "France",
  "Germany",
  "Greece",
  "Hungary",
  "Ireland",
  "Italy",
  "Latvia",
  "Lithuania",
  "Luxembourg",
  "Malta",
  "Netherlands",
  "Poland",
  "Portugal",
  "Romania",
  "Slovakia",
  "Slovenia",
  "Spain",
  "Sweden",
  "United Kingdom",
  "UK",
  "Britain",
  "England",
  "Scotland",
  "Wales",
  "Northern Ireland",
];

const EU_RE = new RegExp(
  `\\b(${EU_UK_COUNTRIES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i"
);

const US_ONLY_RE =
  /\b(united states|u\.s\.a?\.?|usa only|us only|remote\s*[-–]\s*us|north america only|americas only)\b/i;

const WORLDWIDE_RE = /\b(worldwide|anywhere|global|emea|europe|european union|european economic area|eea)\b/i;

const REMOTE_RE =
  /\b(remote|work from home|work-from-home|\bwfh\b|home\s?office|homeoffice|télétravail|teletravail|thuiswerken|home based|fully distributed|en remoto|lavoro da casa|werk van thuis)\b/i;

const HYBRID_ONLY_RE = /\bhybrid\b/i;

/**
 * Fully remote and workable from the EU or UK.
 * Worldwide / Europe-wide remote counts. US-only does not.
 * A location that is only "Remote" (no city or country) counts as open.
 */
export function isEuUkRemote(location, extra = "") {
  const blob = `${location || ""} ${extra || ""}`.replace(/\s+/g, " ").trim();
  if (!blob || !REMOTE_RE.test(blob)) return false;
  if (HYBRID_ONLY_RE.test(location || "") && !/\bremote\b/i.test(location || "")) {
    return false;
  }
  if (US_ONLY_RE.test(blob) && !EU_RE.test(blob) && !/\beurope\b/i.test(blob)) {
    return false;
  }
  if (EU_RE.test(blob) || WORLDWIDE_RE.test(blob)) return true;
  const stripped = blob
    .replace(REMOTE_RE, " ")
    .replace(/[^a-z]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length < 3;
}
