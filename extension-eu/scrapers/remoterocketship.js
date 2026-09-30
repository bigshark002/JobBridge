/**
 * Remote Rocketship. https://www.remoterocketship.com/
 * The Europe and UK pages embed the newest jobs. A subscriber API key
 * pages the same feed (POST /api/openclaw/jobs/).
 */

import { isEuUkRemote } from "./eu.js";
import { isBlockedResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";

const PAGES = [
  "https://www.remoterocketship.com/country/europe/",
  "https://www.remoterocketship.com/gb/remote-jobs/",
];

const EU_LOCATIONS = [
  "Europe",
  "United Kingdom",
  "Austria",
  "Belgium",
  "Bulgaria",
  "Croatia",
  "Cyprus",
  "Czech",
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
];

function mapOpening(job) {
  const company = job.company?.name || "";
  const slug = job.slug || "";
  const companySlug = job.company?.slug || "";
  const listing =
    companySlug && slug
      ? `https://www.remoterocketship.com/publicjobs/company/${companySlug}/jobs/${slug}/`
      : "";
  const countries = []
    .concat(job.location || [])
    .concat(job.locationCountries || [])
    .flat()
    .filter(Boolean)
    .join(", ");
  const summary = [
    job.jobDescriptionSummary,
    job.twoLineJobDescriptionSummary,
    job.roleDescription,
    job.roleRequirements,
    (job.techStack || []).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
  return normalizeJob({
    title: job.roleTitle || job.title || "",
    company,
    location: countries ? `Remote, ${countries}` : "Remote",
    country: countries,
    site: "Remote Rocketship",
    listing_type: job.employmentType || job.locationType || "remote",
    date_posted: String(job.created_at || "").slice(0, 10),
    is_remote: "Yes",
    job_url: listing || job.url || "https://www.remoterocketship.com/",
    job_url_direct: job.url || "",
    description: stripHtml(summary).slice(0, 4000),
  });
}

function acceptOpening(job, { title, hoursOld }) {
  const kind = String(job.locationType || "remote").toLowerCase();
  if (kind && kind !== "remote") return false;
  if (!withinHours(job.created_at, hoursOld)) return false;
  if (title && !titleMatches(job.roleTitle || job.title, title)) return false;
  const place = [job.location, ...(job.locationCountries || [])].filter(Boolean).join(" ");
  return isEuUkRemote(`remote ${place}`);
}

async function scrapeEmbedded({ title, hoursOld, wanted, onProgress }) {
  const matched = [];
  const seen = new Set();
  const errors = [];
  for (const pageUrl of PAGES) {
    const label = pageUrl.includes("/gb/") ? "UK" : "Europe";
    onProgress?.(`Remote Rocketship ${label}`);
    let res;
    let html = "";
    try {
      res = await fetch(pageUrl, { headers: { accept: "text/html" } });
      html = await res.text();
    } catch (err) {
      errors.push(`${label}: ${err?.message || err}`);
      onProgress?.(`Remote Rocketship ${label}: ${err?.message || err}, skipping`);
      continue;
    }
    if (!res.ok || isBlockedResponse(res.status, html)) {
      errors.push(`${label}: HTTP ${res.status}`);
      onProgress?.(`Remote Rocketship ${label}: HTTP ${res.status}, skipping`);
      continue;
    }
    const raw = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)?.[1];
    const openings = parseJson(raw)?.props?.pageProps?.initialJobOpenings || [];
    if (!openings.length) {
      errors.push(`${label}: no job data`);
      continue;
    }
    for (const job of openings) {
      if (!acceptOpening(job, { title, hoursOld })) continue;
      const key = job.id || job.url;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      matched.push(mapOpening(job));
      if (matched.length >= wanted) return matched;
    }
  }
  if (!matched.length && errors.length === PAGES.length) {
    throw new Error(`Remote Rocketship did not respond (${errors[0]})`);
  }
  return matched;
}

async function scrapeApi({ apiKey, title, stack, hoursOld, wanted, onProgress }) {
  const matched = [];
  const seen = new Set();
  const stackTokens = String(stack || "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);

  for (let page = 1; page <= 8 && matched.length < wanted; page++) {
    onProgress?.(`Remote Rocketship API page ${page} (${matched.length}/${wanted})`);
    const res = await fetch("https://www.remoterocketship.com/api/openclaw/jobs/", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        filters: {
          page,
          itemsPerPage: 50,
          locationFilters: EU_LOCATIONS,
          showRemoteJobs: true,
          showHybridJobs: false,
          showOnsiteJobs: false,
          sortBy: "DateAdded",
          jobTitleFilters: title ? [title] : [],
          techStackFilters: stackTokens,
        },
        includeJobDescription: Boolean(stack),
      }),
    });
    const raw = await res.text();
    let data = parseJson(raw, {});
    if (res.status === 401 || res.status === 403) {
      throw new Error(data.message || "Remote Rocketship API key was rejected");
    }
    if (!res.ok) throw new Error(data.message || `Remote Rocketship HTTP ${res.status}`);
    const openings = data.jobOpenings || [];
    if (!openings.length) break;
    let anyRecent = false;
    for (const job of openings) {
      if (!withinHours(job.created_at, hoursOld)) continue;
      anyRecent = true;
      if (!acceptOpening(job, { title, hoursOld })) continue;
      const key = job.id || job.url;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      matched.push(mapOpening(job));
      if (matched.length >= wanted) break;
    }
    if (!data.pagination?.hasNextPage || !anyRecent) break;
  }
  return matched;
}

export async function scrapeRemoteRocketship({
  title,
  stack,
  resultsWanted,
  datePreset,
  rocketshipApiKey,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const key = String(rocketshipApiKey || "").trim();
  if (key) {
    return scrapeApi({
      apiKey: key,
      title,
      stack,
      hoursOld: preset.hoursOld,
      wanted,
      onProgress,
    });
  }
  onProgress?.("Remote Rocketship: newest embedded page (add an API key to page further)");
  return scrapeEmbedded({ title, hoursOld: preset.hoursOld, wanted, onProgress });
}
