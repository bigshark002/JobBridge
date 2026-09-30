/** G2i board on Ashby. https://jobs.ashbyhq.com/g2i */

import { isEuUkRemote } from "./eu.js";
import { isBlockedResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";

const BOARD = "https://api.ashbyhq.com/posting-api/job-board/g2i?includeCompensation=true";

export async function scrapeG2i({ title, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  onProgress?.("G2i Ashby board");
  const res = await fetch(BOARD, { headers: { accept: "application/json" } });
  const raw = await res.text();
  if (!res.ok || isBlockedResponse(res.status, raw)) {
    throw new Error(`G2i HTTP ${res.status}`);
  }
  const jobs = parseJson(raw)?.jobs || [];
  const matched = [];

  for (const job of jobs) {
    const workplace = job.workplaceType || "";
    if (job.isRemote === false && workplace && !/remote/i.test(workplace)) continue;
    if (!withinHours(job.publishedAt, preset.hoursOld)) continue;
    if (title && !titleMatches(job.title, title)) continue;
    const location = job.location || job.address?.postalAddress?.addressCountry || "Remote";
    const description = job.descriptionPlain || stripHtml(job.descriptionHtml || "");
    if (!isEuUkRemote(`remote ${location}`)) continue;
    matched.push(
      normalizeJob({
        title: job.title,
        company: "G2i",
        location,
        country: location,
        site: "G2i",
        listing_type: job.employmentType || workplace || "remote",
        date_posted: String(job.publishedAt || "").slice(0, 10),
        is_remote: "Yes",
        job_url: job.jobUrl || job.applyUrl || "https://jobs.ashbyhq.com/g2i",
        job_url_direct: job.applyUrl || "",
        description: description.slice(0, 4000),
      })
    );
    if (matched.length >= wanted) break;
  }

  return matched;
}
