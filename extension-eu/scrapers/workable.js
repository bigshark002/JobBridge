/**
 * Workable search without a location parameter:
 * https://jobs.workable.com/search?query=backend+engineer&workplace=remote&day_range=1
 * EU and UK jobs are kept from the results. day_range is 1, 2, or 3.
 */

import { isEuUkRemote } from "./eu.js";
import { isBlockedResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches } from "./util.js";

function placeText(job) {
  const country = job.location?.countryName || "";
  const raw = job.locations;
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const extra = list.filter((item) => item && item !== "TELECOMMUTE").join(" ");
  return `${country} ${extra}`.trim();
}

export async function scrapeWorkable({ title, stack, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const query = (title || stack || "").trim();
  const matched = [];
  const seen = new Set();
  let pageToken = "";

  for (let page = 0; page < 15 && matched.length < wanted; page++) {
    const url = new URL("https://jobs.workable.com/api/v1/jobs");
    url.searchParams.set("workplace", "remote");
    url.searchParams.set("day_range", String(preset.days));
    if (query) url.searchParams.set("query", query);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    onProgress?.(`Workable page ${page + 1} (${matched.length}/${wanted})`);
    let res;
    let raw = "";
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
      raw = await res.text();
    } catch (err) {
      if (matched.length) break;
      throw new Error(`Workable request failed (${err?.message || err})`);
    }
    if (!res.ok || isBlockedResponse(res.status, raw)) {
      if (matched.length) break;
      throw new Error(`Workable HTTP ${res.status}`);
    }
    const data = parseJson(raw, null);
    if (!data) {
      if (matched.length) break;
      throw new Error("Workable returned a non-JSON response");
    }
    const jobs = data.jobs || [];
    if (!jobs.length) break;

    for (const job of jobs) {
      if (job.id && seen.has(job.id)) continue;
      if (job.id) seen.add(job.id);
      if (job.workplace && job.workplace !== "remote") continue;
      if (title && !titleMatches(job.title, title)) continue;

      const place = placeText(job);
      const description = stripHtml(job.description || "");
      if (!isEuUkRemote(`remote ${place}`)) continue;

      const country = job.location?.countryName || "";
      const company = job.company?.title || job.company?.name || "";
      matched.push(
        normalizeJob({
          title: job.title,
          company,
          location: country ? `Remote, ${country}` : "Remote",
          country,
          site: "Workable",
          listing_type: job.employmentType || "remote",
          date_posted: String(job.created || "").slice(0, 10),
          is_remote: "Yes",
          job_url: job.url || "",
          description: description.slice(0, 4000),
        })
      );
      if (matched.length >= wanted) break;
    }

    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  return matched;
}
