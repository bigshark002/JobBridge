/**
 * Indeed scraper — remote attribute filter (DSQF7) + title query.
 * Date is applied client-side (Indeed cannot combine date + remote filters).
 */

import {
  normalizeJob,
  formatLocation,
  stripHtml,
  resolveDatePreset,
  filterByHoursOld,
  filterByTitle,
} from "./util.js";
import { blockedError, isBlockedResponse } from "./http.js";

const API_URL = "https://apis.indeed.com/graphql";
const BASE_URL = "https://www.indeed.com";

const HEADERS = {
  "content-type": "application/json",
  "indeed-api-key":
    "161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8",
  accept: "application/json",
  "indeed-locale": "en-US",
  "accept-language": "en-US,en;q=0.9",
  "indeed-co": "US",
  "indeed-app-info":
    "appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone",
};

const QUERY_TMPL = `
query GetJobData {
  jobSearch(
    {{WHAT}}
    {{LOCATION}}
    limit: 100
    {{CURSOR}}
    sort: DATE
    filters: {
      composite: {
        filters: [{
          keyword: {
            field: "attributes"
            keys: ["DSQF7"]
          }
        }]
      }
    }
  ) {
    pageInfo { nextCursor }
    results {
      job {
        key
        title
        datePublished
        description { html }
        location {
          city
          admin1Code
          countryCode
          formatted { long }
        }
        employer { name }
        recruit { viewJobUrl }
      }
    }
  }
}
`;

function buildQuery(whatTerm, cursor) {
  // Quote multi-word titles so Indeed treats them as a phrase when possible
  const escaped = (whatTerm || "").replace(/"/g, '\\"').trim();
  const what = escaped ? `what: "${escaped}"` : "";
  const location = `location: { where: "United States", radius: 100, radiusUnit: MILES }`;
  const cursorPart = cursor ? `cursor: "${cursor}"` : "";
  return QUERY_TMPL.replace("{{WHAT}}", what)
    .replace("{{LOCATION}}", location)
    .replace("{{CURSOR}}", cursorPart);
}

function toDatePosted(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/**
 * @param {{
 *   searchTerm: string,
 *   title?: string,
 *   resultsWanted: number,
 *   datePreset?: string,
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeIndeed({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const whatTerm = (title || searchTerm || "").trim();
  const titleFilter = (title || "").trim();
  const matched = [];
  const seen = new Set();
  let scanned = 0;
  let cursor = null;
  let page = 0;
  // `what` also matches descriptions: title hits are spread across ~1000 results
  const MAX_PAGES = 10;

  while (matched.length < resultsWanted && page < MAX_PAGES) {
    page += 1;
    onProgress?.(
      `Indeed page ${page} (${preset.label}, ${matched.length}/${resultsWanted} matching)…`
    );
    const query = buildQuery(whatTerm, cursor);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ query }),
    });
    const raw = await res.text();
    if (!res.ok || isBlockedResponse(res.status, raw)) {
      throw blockedError("indeed", res.status, raw);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Indeed returned non-JSON (blocked or unexpected response)");
    }
    const search = data?.data?.jobSearch;
    if (!search) {
      const err = data?.errors?.[0]?.message;
      throw new Error(err || "Indeed returned no jobSearch data");
    }
    const results = search.results || [];
    if (!results.length) break;

    const pageJobs = [];
    for (const row of results) {
      const job = row.job;
      if (!job?.key) continue;
      const jobUrl = `${BASE_URL}/viewjob?jk=${job.key}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);
      scanned += 1;
      const loc = job.location || {};
      pageJobs.push(
        normalizeJob({
          title: job.title,
          company: job.employer?.name || "",
          location:
            loc.formatted?.long ||
            formatLocation([loc.city, loc.admin1Code, loc.countryCode]),
          site: "indeed",
          date_posted: toDatePosted(job.datePublished),
          is_remote: true,
          job_url: jobUrl,
          job_url_direct: job.recruit?.viewJobUrl || "",
          description: stripHtml(job.description?.html),
        })
      );
    }
    matched.push(
      ...filterByTitle(filterByHoursOld(pageJobs, preset.hoursOld), titleFilter)
    );

    cursor = search.pageInfo?.nextCursor || null;
    if (!cursor) break;
  }

  onProgress?.(`Indeed: ${scanned} scanned → ${matched.length} matching title`);
  return matched.slice(0, resultsWanted);
}
