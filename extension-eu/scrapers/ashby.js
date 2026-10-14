/**
 * Ashby hosted boards. https://jobs.ashbyhq.com/ has no shared job list.
 * Each company is https://jobs.ashbyhq.com/{company}, read from the public posting API.
 * Only Remote roles are kept, then title and EU/UK location filters apply.
 */

import { isEuUkRemote } from "./eu.js";
import { isBlockedResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";

const OUTSIDE_EU_UK = /\b(united states|u\.s\.a?\.?|canada|australia|new zealand|brazil|india|mexico|singapore|japan|latam|latin america)\b/i;

export function parseAshbyBoards(value) {
  const slugs = [];
  for (const part of String(value || "").split(/[\s,;]+/)) {
    const raw = part.trim();
    if (!raw) continue;
    const fromUrl = raw.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i)?.[1];
    const slug = (fromUrl || raw).replace(/^\/+|\/+$/g, "");
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) continue;
    slugs.push(slug);
  }
  return [...new Set(slugs)];
}

function placeText(job) {
  const location = job.location || "";
  const country = job.address?.postalAddress?.addressCountry || "";
  if (!country || location.toLowerCase().includes(country.toLowerCase())) return location || "Remote";
  return `${location}, ${country}`.trim();
}

function isRemoteWorkplace(job) {
  return job.isRemote === true || /remote/i.test(job.workplaceType || "");
}

async function companyName(slug) {
  try {
    const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query($n:String!){ organizationFromHostedJobsPageName(organizationHostedJobsPageName:$n){ name } }",
        variables: { n: slug },
      }),
    });
    const name = parseJson(await res.text())?.data?.organizationFromHostedJobsPageName?.name;
    if (name) return name;
  } catch {
    /* the board slug is enough */
  }
  return slug;
}

export async function scrapeAshby({ title, resultsWanted, datePreset, ashbyBoards, onProgress }) {
  const boards = parseAshbyBoards(ashbyBoards);
  if (!boards.length) {
    throw new Error(
      "Ashby has no job list at https://jobs.ashbyhq.com/. Add company boards such as https://jobs.ashbyhq.com/notion in the Ashby boards field."
    );
  }

  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const matched = [];
  const seen = new Set();
  let lastError = "";

  for (const slug of boards) {
    if (matched.length >= wanted) break;
    onProgress?.(`Ashby ${slug} (${matched.length}/${wanted})`);
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
    let res;
    let raw = "";
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
      raw = await res.text();
    } catch (err) {
      lastError = `Ashby ${slug} request failed (${err?.message || err})`;
      continue;
    }
    if (res.status === 404) {
      lastError = `Ashby board “${slug}” was not found`;
      continue;
    }
    if (!res.ok || isBlockedResponse(res.status, raw)) {
      lastError = `Ashby ${slug} HTTP ${res.status}`;
      continue;
    }
    const jobs = parseJson(raw)?.jobs || [];
    if (!jobs.length) continue;
    const company = await companyName(slug);

    for (const job of jobs) {
      if (job.isListed === false) continue;
      if (!isRemoteWorkplace(job)) continue;
      if (!withinHours(job.publishedAt, preset.hoursOld)) continue;
      if (title && !titleMatches(job.title, title)) continue;
      const location = placeText(job);
      if (OUTSIDE_EU_UK.test(location)) continue;
      if (!isEuUkRemote(`remote ${location}`)) continue;
      const jobUrl = job.jobUrl || job.applyUrl || `https://jobs.ashbyhq.com/${slug}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);
      const description = job.descriptionPlain || stripHtml(job.descriptionHtml || "");
      matched.push(
        normalizeJob({
          title: job.title,
          company,
          location,
          country: job.address?.postalAddress?.addressCountry || location,
          site: "Ashby",
          listing_type: job.employmentType || job.workplaceType || "Remote",
          date_posted: String(job.publishedAt || "").slice(0, 10),
          is_remote: "Yes",
          job_url: jobUrl,
          job_url_direct: job.applyUrl || "",
          description: description.slice(0, 4000),
        })
      );
      if (matched.length >= wanted) break;
    }
  }

  if (!matched.length && lastError && boards.length === 1) throw new Error(lastError);
  return matched;
}
