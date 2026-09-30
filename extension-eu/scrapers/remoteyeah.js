/**
 * RemoteYeah listing.
 * https://remoteyeah.com/remote-jobs-in-europe+united-kingdom
 * The page is already Europe and the UK. Jobs are then filtered by title.
 */

import { isBlockedResponse } from "./http.js";
import { normalizeJob, resolveDatePreset, titleMatches, withinHours } from "./util.js";

const ROOT = "https://remoteyeah.com/remote-jobs-in-europe+united-kingdom";

function text(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#x24;/g, "$")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCards(html) {
  const cards = [];
  for (const part of html.split("<article")) {
    if (!part.includes("job-card-title")) continue;
    const href = part.match(/class="job-card-title"[^>]*href="([^"]+)"/)?.[1]
      || part.match(/href="(https:\/\/remoteyeah.com\/jobs\/[^"]+)"/)?.[1];
    const title = text(part.match(/job-card-title-text">([^<]+)/)?.[1]);
    const company = text(part.match(/job-card-company">([^<]+)/)?.[1]);
    const posted = part.match(/datetime="([^"]+)"/)?.[1] || "";
    const location = text(
      part.match(/job-card-tag-location[\s\S]{0,240}?<\/span>\s*([^<]+)/)?.[1]
    );
    const skills = [...part.matchAll(/job-card-tag-skill[^>]*>\s*([^<]+)/g)].map((m) =>
      text(m[1])
    );
    if (!title || !href) continue;
    cards.push({ href, title, company, posted, location, skills });
  }
  return cards;
}

export async function scrapeRemoteYeah({ title, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const matched = [];
  const seen = new Set();

  for (let page = 1; page <= 8 && matched.length < wanted; page++) {
    const url = page === 1 ? ROOT : `${ROOT}/page/${page}`;
    onProgress?.(`RemoteYeah page ${page} (${matched.length}/${wanted})`);
    let res;
    let html = "";
    try {
      res = await fetch(url, { headers: { accept: "text/html" } });
      html = await res.text();
    } catch (err) {
      if (matched.length) break;
      throw new Error(`RemoteYeah request failed (${err?.message || err})`);
    }
    if (!res.ok || isBlockedResponse(res.status, html)) {
      if (matched.length) break;
      throw new Error(`RemoteYeah HTTP ${res.status}`);
    }
    const cards = parseCards(html);
    if (!cards.length) break;

    let newest = 0;
    for (const card of cards) {
      const postedMs = Date.parse(card.posted);
      if (!Number.isNaN(postedMs) && postedMs > newest) newest = postedMs;
      if (!card.posted || !withinHours(card.posted, preset.hoursOld)) continue;
      if (seen.has(card.href)) continue;
      seen.add(card.href);
      if (title && !titleMatches(card.title, title)) continue;
      const place = card.location || "Remote";
      matched.push(
        normalizeJob({
          title: card.title,
          company: card.company,
          location: place,
          country: place,
          site: "RemoteYeah",
          listing_type: "remote",
          date_posted: card.posted.slice(0, 10),
          is_remote: "Yes",
          job_url: card.href,
          description: card.skills.join(", "),
        })
      );
      if (matched.length >= wanted) break;
    }

    const cutoff = Date.now() - preset.hoursOld * 3600 * 1000;
    if (newest && newest < cutoff) break;
  }

  return matched;
}
