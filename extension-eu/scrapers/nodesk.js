/**
 * NoDesk remote jobs. The newsletter is https://nodesk.substack.com/;
 * listings are the public Algolia index on https://nodesk.co/remote-jobs/.
 */

import { isEuUkRemote } from "./eu.js";
import { normalizeJob, resolveDatePreset, stripHtml, titleMatches, withinHours } from "./util.js";
import { parseJson } from "./http.js";

const ENDPOINT = "https://0586L1SOK8-dsn.algolia.net/1/indexes/jobPosts/query";

export async function scrapeNodesk({ title, stack, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const query = [title, stack].map((s) => String(s || "").trim()).filter(Boolean).join(" ");
  const matched = [];
  const cutoff = Date.now() - preset.hoursOld * 3600 * 1000;

  for (let page = 0; page < 8 && matched.length < wanted; page++) {
    onProgress?.(`NoDesk page ${page + 1} (${matched.length}/${wanted})`);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-algolia-application-id": "0586L1SOK8",
        "x-algolia-api-key": "8dacb58c6f375cba28e19ecf1f03e9e1",
        referer: "https://nodesk.co/",
        origin: "https://nodesk.co",
      },
      body: JSON.stringify({ query, hitsPerPage: 50, page }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`NoDesk HTTP ${res.status}`);
    const data = parseJson(raw, null);
    if (!data) throw new Error("NoDesk returned a non-JSON response");
    const hits = data.hits || [];
    if (!hits.length) break;

    let newest = 0;
    for (const hit of hits) {
      const postedMs = Date.parse(hit.datePublished || "");
      if (!Number.isNaN(postedMs) && postedMs > newest) newest = postedMs;
      if (!withinHours(hit.datePublished, preset.hoursOld)) continue;
      if (title && !titleMatches(hit.title, title)) continue;
      const regions = (hit.applicantLocationRegions || []).join(" ");
      const places = (hit.applicantLocations || []).map((p) => p?.name || "").join(" ");
      const blob = `${regions} ${places}`;
      if (!isEuUkRemote(`remote ${blob}`)) continue;
      const path = hit.permalink || "";
      const keywords = (hit.keywords || []).map((k) => k?.name || "").filter(Boolean);
      matched.push(
        normalizeJob({
          title: hit.title,
          company: hit.company?.name || "",
          location: places || regions || "Remote",
          country: places || regions || "",
          site: "NoDesk",
          listing_type: (hit.employmentTypes || []).map((t) => t?.name || "").filter(Boolean).join(", "),
          date_posted: String(hit.datePublished || "").slice(0, 10),
          is_remote: "Yes",
          job_url: path.startsWith("http") ? path : `https://nodesk.co${path}`,
          description: stripHtml(keywords.join(", ")).slice(0, 2000),
        })
      );
      if (matched.length >= wanted) break;
    }

    if (newest && newest < cutoff) break;
  }

  return matched;
}
