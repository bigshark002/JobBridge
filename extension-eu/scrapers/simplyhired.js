/**
 * SimplyHired remote search.
 * https://www.simplyhired.com/search?q=AI+engineer&l=Remote
 * t=1|2|3 is the posted-day window. Jobs are then filtered by title.
 */

import { isBlockedResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";

const HOST = "www.simplyhired.com";

function pageJobs(html) {
  const raw = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)?.[1];
  if (!raw) return null;
  const pageProps = parseJson(raw)?.props?.pageProps;
  if (!pageProps) return null;
  return {
    jobs: pageProps.jobs || [],
    cursors: pageProps.pageCursors || {},
  };
}

export async function scrapeSimplyHired({ title, stack, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const query = (title || stack || "").trim();
  const matched = [];
  const seen = new Set();
  let cursor = "";

  for (let page = 1; page <= 8 && matched.length < wanted; page++) {
    const url = new URL(`https://${HOST}/search`);
    if (query) url.searchParams.set("q", query);
    url.searchParams.set("l", "Remote");
    url.searchParams.set("t", String(preset.days));
    if (cursor) url.searchParams.set("cursor", cursor);

    onProgress?.(`SimplyHired page ${page} (${matched.length}/${wanted})`);
    let res;
    let html = "";
    try {
      res = await fetch(url, {
        headers: {
          accept: "text/html",
          "user-agent": "Mozilla/5.0",
        },
      });
      html = await res.text();
    } catch (err) {
      if (matched.length) break;
      throw new Error(`SimplyHired request failed (${err?.message || err})`);
    }
    if (!res.ok || isBlockedResponse(res.status, html)) {
      if (matched.length) break;
      throw new Error(
        res.status === 403
          ? "SimplyHired HTTP 403. Reload the extension so the SimplyHired header rule is installed, then try again."
          : `SimplyHired HTTP ${res.status}`
      );
    }
    const parsed = pageJobs(html);
    if (!parsed || !parsed.jobs.length) break;

    let anyRecent = false;
    for (const job of parsed.jobs) {
      const key = job.jobKey || job.botUrl;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const posted = job.dateOnIndeed ? new Date(job.dateOnIndeed).toISOString() : "";
      if (posted && !withinHours(posted, preset.hoursOld)) continue;
      if (posted) anyRecent = true;
      if (title && !titleMatches(job.title, title)) continue;

      const path = job.botUrl || (job.jobKey ? `/job/${job.jobKey}` : "");
      matched.push(
        normalizeJob({
          title: job.title,
          company: job.company || "",
          location: job.location || "Remote",
          country: job.location || "Remote",
          site: "SimplyHired",
          listing_type: (job.jobTypes || []).join(", "),
          date_posted: posted.slice(0, 10),
          is_remote: "Yes",
          job_url: path ? `https://${HOST}${path}` : `https://${HOST}/`,
          description: stripHtml(job.snippet || "").slice(0, 2000),
        })
      );
      if (matched.length >= wanted) break;
    }

    const next = parsed.cursors[String(page + 1)];
    cursor = typeof next === "string" ? next : next?.cursor || "";
    if (!cursor || !anyRecent) break;
  }

  return matched;
}
