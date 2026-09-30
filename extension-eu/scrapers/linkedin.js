/**
 * LinkedIn guest search for fully remote EU and UK jobs.
 * Two markets only (EU, then UK). Extra country loops are what trip the 429 limit.
 * 429/999 wait and retry, then jobs already collected are kept.
 */

import { isBlockedResponse } from "./http.js";
import { normalizeJob, resolveDatePreset, sleep, stripHtml, titleMatches, withinHours } from "./util.js";

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

const MARKETS = [
  { name: "European Union", geoId: "91000000" },
  { name: "United Kingdom", geoId: "101165590" },
];

function parseCards(html) {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [...doc.querySelectorAll("div.base-search-card")].map((card) => {
      const href = (card.querySelector("a.base-card__full-link")?.getAttribute("href") || "").split("?")[0];
      const id =
        href.split("-").pop() ||
        (card.getAttribute("data-entity-urn") || "").split(":").pop();
      const timeEl =
        card.querySelector("time.job-search-card__listdate") ||
        card.querySelector("time.job-search-card__listdate--new");
      return {
        id,
        title: stripHtml(
          card.querySelector("span.sr-only")?.textContent ||
            card.querySelector("h3.base-search-card__title")?.textContent ||
            ""
        ),
        company: stripHtml(
          card.querySelector("h4.base-search-card__subtitle a")?.textContent ||
            card.querySelector("h4.base-search-card__subtitle")?.textContent ||
            ""
        ),
        location: stripHtml(card.querySelector("span.job-search-card__location")?.textContent || ""),
        datePosted: timeEl?.getAttribute("datetime") || "",
      };
    }).filter((card) => card.id && card.title);
  }

  const cards = [];
  for (const part of html.split('data-entity-urn="urn:li:jobPosting:').slice(1)) {
    const id = part.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const title = stripHtml(
      part.match(/class="sr-only">([\s\S]*?)<\/span>/)?.[1] ||
        part.match(/base-search-card__title">([\s\S]*?)<\/h3>/)?.[1] ||
        ""
    );
    const company = stripHtml(
      part.match(/base-search-card__subtitle[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ||
        part.match(/base-search-card__subtitle">([\s\S]*?)<\/h4>/)?.[1] ||
        ""
    );
    const location = stripHtml(
      part.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1] || ""
    );
    const datePosted = part.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1] || "";
    if (!title) continue;
    cards.push({ id, title, company, location, datePosted });
  }
  return cards;
}

async function fetchPage(params, onProgress) {
  const url = `${SEARCH_URL}?${params}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      const wait = 8000 * (attempt + 1);
      onProgress?.(`LinkedIn request failed (${err?.message || err}), waiting ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
      continue;
    }
    if (res.status !== 429 && res.status !== 999) return res;
    const wait = 12000 * (attempt + 1);
    onProgress?.(`LinkedIn rate limit (${res.status}), waiting ${Math.round(wait / 1000)}s…`);
    await sleep(wait);
  }
  return null;
}

export async function scrapeLinkedIn({ title, stack, resultsWanted, datePreset, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  const wanted = Math.max(1, resultsWanted || 50);
  const keywords = (title || stack || "").trim();
  const matched = [];
  const seen = new Set();
  let rateLimited = false;

  for (const market of MARKETS) {
    if (matched.length >= wanted || rateLimited) break;
    let start = 0;
    for (let page = 1; page <= 8 && matched.length < wanted; page++) {
      onProgress?.(`LinkedIn ${market.name} page ${page} (${matched.length}/${wanted})`);
      const params = new URLSearchParams({
        keywords,
        location: market.name,
        geoId: market.geoId,
        f_WT: "2",
        f_TPR: `r${preset.hoursOld * 3600}`,
        start: String(start),
        pageNum: "0",
      });
      const res = await fetchPage(params, onProgress);
      if (!res) {
        rateLimited = true;
        onProgress?.("LinkedIn rate limit reached. Keeping jobs already found.");
        break;
      }
      if (!res.ok || isBlockedResponse(res.status)) {
        if (isBlockedResponse(res.status)) {
          rateLimited = true;
          onProgress?.(`LinkedIn HTTP ${res.status}. Keeping jobs already found.`);
          break;
        }
        throw new Error(`LinkedIn HTTP ${res.status}`);
      }
      const cards = parseCards(await res.text());
      if (!cards.length) break;

      for (const card of cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        if (!withinHours(card.datePosted, preset.hoursOld)) continue;
        if (title && !titleMatches(card.title, title)) continue;
        matched.push(
          normalizeJob({
            title: card.title,
            company: card.company,
            location: card.location,
            country: card.location,
            site: "LinkedIn",
            listing_type: "remote",
            date_posted: card.datePosted,
            is_remote: "Yes",
            job_url: `https://www.linkedin.com/jobs/view/${card.id}`,
          })
        );
        if (matched.length >= wanted) break;
      }

      start += Math.max(cards.length, 10);
      if (matched.length < wanted) await sleep(3000 + Math.random() * 1500);
    }
    if (matched.length < wanted && !rateLimited) await sleep(4000);
  }

  if (!matched.length && rateLimited) {
    throw new Error("LinkedIn rate-limited. Wait a few minutes and try LinkedIn on its own.");
  }
  return matched;
}
