/**
 * Djinni keyword search.
 * https://djinni.co/jobs/?all_keywords=ai+engineer&search_type=basic-search
 * The public /api/jobs/ feed ignores keywords, so this reads the search page.
 * employment=remote is not sent: it drops hybrid remote titles such as
 * "Trainee AI/ML Engineer" that the keyword page still shows.
 */

import { isBlockedResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";

const EU_CODES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB", "UK",
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN",
  "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP",
  "SWE", "GBR",
]);

/** Djinni is a Ukrainian board; remote roles are usually tagged UA or UKR. */
const UA_CODES = new Set(["UA", "UKR"]);

function locationItems(job) {
  const req = job.applicantLocationRequirements;
  if (!req) return [];
  return Array.isArray(req) ? req : [req];
}

/**
 * Europe, UK, worldwide, or Ukraine. Other countries (Georgia-only, US) stay out.
 * A card open to Ukraine plus another country is kept.
 */
function isAllowedLocation(job, cardLocation) {
  if (/\b(ukraine|europe|worldwide|anywhere|global|emea|united kingdom)\b/i.test(cardLocation || "")) {
    return true;
  }
  const items = locationItems(job);
  if (!items.length) return true;
  for (const item of items) {
    const address = item.address || {};
    const region = String(address.addressRegion || "");
    const country = String(address.addressCountry || "").toUpperCase();
    if (/\b(europe|worldwide|anywhere|global|emea)\b/i.test(region)) return true;
    if (EU_CODES.has(country) || UA_CODES.has(country)) return true;
  }
  return false;
}

/** Full Remote and Hybrid Remote. Office-only cards are dropped. */
function remoteLabel(job, cardRemote) {
  const label = String(cardRemote || "").replace(/\s+/g, " ").trim();
  if (/hybrid\s+remote/i.test(label)) return "Hybrid Remote";
  if (/full\s+remote|^remote$/i.test(label) || job.jobLocationType === "TELECOMMUTE") return "Full Remote";
  if (/\bremote\b/i.test(label) && !/office/i.test(label)) return label;
  return "";
}

function locationLabel(job) {
  const parts = [];
  for (const item of locationItems(job)) {
    const address = item.address || {};
    if (address.addressRegion) parts.push(address.addressRegion);
    if (address.addressCountry) parts.push(address.addressCountry);
    if (address.addressLocality) parts.push(address.addressLocality);
  }
  return parts.length ? parts.join(", ") : "Remote";
}

function cardMeta(html) {
  const meta = new Map();
  for (const part of html.split('id="job-item-').slice(1)) {
    const id = part.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const head = part.slice(0, 5000);
    const formats = [...head.matchAll(/text-nowrap">\s*([^<]+)/g)].map((match) =>
      match[1].replace(/\s+/g, " ").trim()
    );
    meta.set(id, {
      remote: formats.find((item) => /remote/i.test(item)) || "",
      location: head.match(/location-text">([^<]+)/)?.[1]?.trim() || "",
    });
  }
  return meta;
}

function jobId(job) {
  if (job.identifier != null) return String(job.identifier);
  return String(job.url || "").match(/\/jobs\/(\d+)/)?.[1] || "";
}

function postedJobs(html) {
  const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return [];
  const data = parseJson(raw, null);
  if (!data) return [];
  const list = Array.isArray(data) ? data : data.itemListElement || [];
  return list
    .map((item) => item.item || item)
    .filter((item) => item && item["@type"] === "JobPosting");
}

export async function scrapeDjinni({ title, stack, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const keywords = (title || stack || "").trim();
  const matched = [];
  const seen = new Set();

  for (let page = 1; page <= 15 && matched.length < wanted; page++) {
    const url = new URL("https://djinni.co/jobs/");
    url.searchParams.set("search_type", "basic-search");
    if (keywords) url.searchParams.set("all_keywords", keywords);
    if (page > 1) url.searchParams.set("page", String(page));

    onProgress?.(`Djinni page ${page} (${matched.length}/${wanted})`);
    let res;
    let html = "";
    try {
      res = await fetch(url, { headers: { accept: "text/html" } });
      html = await res.text();
    } catch (err) {
      throw new Error(`Djinni request failed (${err?.message || err})`);
    }
    if (!res.ok || isBlockedResponse(res.status, html)) {
      throw new Error(`Djinni HTTP ${res.status}`);
    }
    const jobs = postedJobs(html);
    if (!jobs.length) break;
    const cards = cardMeta(html);

    let newest = 0;
    for (const job of jobs) {
      const postedMs = Date.parse(job.datePosted || "");
      if (!Number.isNaN(postedMs) && postedMs > newest) newest = postedMs;
      if (!withinHours(job.datePosted, preset.hoursOld)) continue;
      if (title && !titleMatches(job.title, title)) continue;
      const card = cards.get(jobId(job)) || {};
      const listing = remoteLabel(job, card.remote);
      if (!listing) continue;
      if (!isAllowedLocation(job, card.location)) continue;
      const jobUrl = job.url || "";
      if (jobUrl && seen.has(jobUrl)) continue;
      if (jobUrl) seen.add(jobUrl);
      const place = card.location || locationLabel(job);
      const description = stripHtml(job.description || "");
      matched.push(
        normalizeJob({
          title: job.title,
          company: job.hiringOrganization?.name || "",
          location: place,
          country: place,
          site: "Djinni",
          listing_type: listing,
          date_posted: String(job.datePosted || "").slice(0, 10),
          is_remote: "Yes",
          job_url: jobUrl,
          description: description.slice(0, 4000),
        })
      );
      if (matched.length >= wanted) break;
    }

    const cutoff = Date.now() - preset.hoursOld * 3600 * 1000;
    if (newest && newest < cutoff) break;
  }

  return matched;
}
