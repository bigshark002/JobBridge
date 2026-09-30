/** SimplyHired country sites (EU + UK). https://www.simplyhired.com/ */

import { isEuUkRemote } from "./eu.js";
import { isBlockedResponse, isRedirectResponse, parseJson } from "./http.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";

const COUNTRIES = [
  { host: "www.simplyhired.co.uk", name: "United Kingdom" },
  { host: "www.simplyhired.ie", name: "Ireland" },
  { host: "www.simplyhired.de", name: "Germany" },
  { host: "www.simplyhired.fr", name: "France" },
  { host: "www.simplyhired.nl", name: "Netherlands" },
  { host: "www.simplyhired.es", name: "Spain" },
  { host: "www.simplyhired.it", name: "Italy" },
  { host: "www.simplyhired.se", name: "Sweden" },
  { host: "www.simplyhired.at", name: "Austria" },
  { host: "www.simplyhired.be", name: "Belgium" },
  { host: "www.simplyhired.pt", name: "Portugal" },
];

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
  let blocked = 0;
  let attempted = 0;

  for (const country of COUNTRIES) {
    if (matched.length >= wanted) break;
    let cursor = "";
    for (let page = 1; page <= 6 && matched.length < wanted; page++) {
      const url = new URL(`https://${country.host}/search`);
      if (query) url.searchParams.set("q", query);
      url.searchParams.set("l", "remote");
      url.searchParams.set("t", String(preset.days));
      if (cursor) url.searchParams.set("cursor", cursor);

      onProgress?.(`SimplyHired ${country.name} (${matched.length}/${wanted})`);
      let res;
      let html = "";
      try {
        res = await fetch(url, {
          redirect: "manual",
          headers: {
            accept: "text/html",
            "user-agent": "Mozilla/5.0",
          },
        });
      } catch (err) {
        onProgress?.(`SimplyHired ${country.name}: ${err?.message || err}, skipping`);
        break;
      }
      if (isRedirectResponse(res) || (res.url && new URL(res.url).host !== country.host)) {
        onProgress?.(`SimplyHired ${country.name}: redirected, skipping`);
        break;
      }
      try {
        html = await res.text();
      } catch (err) {
        onProgress?.(`SimplyHired ${country.name}: ${err?.message || err}, skipping`);
        break;
      }
      attempted += 1;
      if (res.status === 404) break;
      if (!res.ok || isBlockedResponse(res.status, html)) {
        if (res.status === 403 || isBlockedResponse(res.status, html)) blocked += 1;
        onProgress?.(`SimplyHired ${country.name}: HTTP ${res.status}, skipping`);
        break;
      }
      const parsed = pageJobs(html);
      if (!parsed) break;
      if (!parsed.jobs.length) break;

      let anyRecent = false;
      for (const job of parsed.jobs) {
        const key = job.jobKey || job.botUrl;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const posted = job.dateOnIndeed ? new Date(job.dateOnIndeed).toISOString() : "";
        if (posted && !withinHours(posted, preset.hoursOld)) continue;
        if (posted) anyRecent = true;
        if (title && !titleMatches(job.title, title)) continue;

        const attrs = (job.remoteAttributes || []).join(" ");
        const location = job.location || "";
        if (!isEuUkRemote(`${attrs} ${location} ${country.name}`)) continue;
        if (!/\b(remote|home\s?office|homeoffice|en remoto|lavoro da casa|werk van thuis|télétravail|teletravail|thuiswerken|wfh)\b/i.test(`${attrs} ${location}`)) {
          continue;
        }

        const path = job.botUrl || (job.jobKey ? `/job/${job.jobKey}` : "");
        matched.push(
          normalizeJob({
            title: job.title,
            company: job.company || "",
            location: location || "Remote",
            country: country.name,
            site: "SimplyHired",
            listing_type: (job.jobTypes || []).join(", "),
            date_posted: posted.slice(0, 10),
            is_remote: "Yes",
            job_url: path ? `https://${country.host}${path}` : `https://${country.host}/`,
            description: stripHtml(job.snippet || "").slice(0, 2000),
          })
        );
        if (matched.length >= wanted) break;
      }

      const next = parsed.cursors[String(page + 1)];
      cursor = typeof next === "string" ? next : next?.cursor || "";
      if (!cursor || !anyRecent) break;
    }
  }

  if (!matched.length && attempted && blocked === attempted) {
    throw new Error(
      "SimplyHired HTTP 403. Reload the extension so the SimplyHired header rule is installed, then try again."
    );
  }

  return matched;
}
