/**
 * Background service worker.
 * - Keeps declarativeNetRequest host access alive
 * - Runs Glassdoor / ZipRecruiter / Jobright / Dice scrapes inside real site tabs (avoids CF 403)
 */

import { FALLBACK_CSRF, GLASSDOOR_QUERY } from "./scrapers/glassdoor-query.js";

const GD_URL = "https://www.glassdoor.com/Job/remote-jobs.htm";
const ZR_URL = "https://www.ziprecruiter.com/jobs-search?search=remote&remote=1";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialize tab create/update across Glassdoor + ZipRecruiter. */
let tabOpQueue = Promise.resolve();
function enqueueTabOp(fn) {
  const next = tabOpQueue.then(fn, fn);
  tabOpQueue = next.catch(() => {});
  return next;
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab timed out loading"));
    }, timeoutMs);

    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
      else chrome.tabs.onUpdated.addListener(onUpdated);
    }, reject);
  });
}

async function withTabRetry(fn, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      if (!/cannot be edited|dragging a tab/i.test(msg)) throw err;
      await sleep(400 + i * 350);
    }
  }
  throw lastErr;
}

/**
 * Open or reuse a site tab. Avoids forcing focus on existing tabs (that
 * triggers "Tabs cannot be edited right now" when the user is switching tabs).
 * New tabs are opened focused so Cloudflare challenges are visible.
 */
async function ensureSiteTab(urlPatterns, openUrl, { navigate = false } = {}) {
  return enqueueTabOp(() =>
    withTabRetry(async () => {
      const existing = await chrome.tabs.query({ url: urlPatterns });
      let tab = existing[0] || null;

      if (!tab) {
        tab = await chrome.tabs.create({ url: openUrl, active: true });
        await waitTabComplete(tab.id);
        await sleep(1200);
        return { tab: await chrome.tabs.get(tab.id), created: true };
      }

      if (navigate && openUrl) {
        await chrome.tabs.update(tab.id, { url: openUrl });
        await waitTabComplete(tab.id);
        await sleep(800);
      } else if (tab.status !== "complete") {
        await waitTabComplete(tab.id);
      }

      return { tab: await chrome.tabs.get(tab.id), created: false };
    })
  );
}

/**
 * Runs in the Glassdoor page context.
 */
async function glassdoorPageScrape(args) {
  const {
    searchTerm,
    resultsWanted,
    fromAge,
    query,
    fallbackToken,
  } = args;

  const BASE = "https://www.glassdoor.com";
  const JOBS_PER_PAGE = 30;

  if (
    /security\s*\|\s*glassdoor/i.test(document.title) ||
    /attention required|cf-browser-verification/i.test(
      document.body?.innerText || ""
    )
  ) {
    return {
      error:
        "Glassdoor security check is open in a tab. Complete it, then press OK again.",
    };
  }

  async function getToken() {
    try {
      const res = await fetch(`${BASE}/Job/computer-science-jobs.htm`, {
        credentials: "include",
        headers: { accept: "text/html" },
      });
      const html = await res.text();
      if (/security\s*\|\s*glassdoor/i.test(html.slice(0, 2000))) {
        return null;
      }
      const m = html.match(/"token":\s*"([^"]+)"/);
      return m ? m[1] : fallbackToken;
    } catch {
      return fallbackToken;
    }
  }

  const token = (await getToken()) || fallbackToken;
  if (!token) {
    return {
      error:
        "Glassdoor blocked session. Open glassdoor.com, pass the security check, retry.",
    };
  }

  const jobs = [];
  const seen = new Set();
  let cursor = null;
  const maxPages = Math.min(30, Math.ceil(resultsWanted / JOBS_PER_PAGE) + 2);
  const locationId = 11047;
  const locationType = "STATE";

  for (let page = 1; page <= maxPages && jobs.length < resultsWanted; page++) {
    const payload = [
      {
        operationName: "JobSearchResultsQuery",
        variables: {
          excludeJobListingIds: [],
          filterParams: [{ filterKey: "fromAge", values: String(fromAge) }],
          keyword: searchTerm || "",
          numJobsToShow: JOBS_PER_PAGE,
          locationType,
          locationId,
          parameterUrlInput: `IL.0,12_I${locationType}${locationId}`,
          pageNumber: page,
          pageCursor: cursor,
          fromage: fromAge,
          sort: "date",
        },
        query,
      },
    ];

    const res = await fetch(`${BASE}/graph`, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "apollographql-client-name": "job-search-next",
        "apollographql-client-version": "4.65.5",
        "gd-csrf-token": token,
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    if (!res.ok || /security\s*\|\s*glassdoor/i.test(raw.slice(0, 500))) {
      return {
        error: `Glassdoor HTTP ${res.status} (blocked). Complete the security check in the Glassdoor tab, then retry.`,
        rawCount: jobs.length,
        jobs,
      };
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return {
        error: "Glassdoor returned non-JSON",
        jobs,
        rawCount: jobs.length,
      };
    }

    const resJson = Array.isArray(body) ? body[0] : body;
    const listings = resJson?.data?.jobListings?.jobListings || [];
    if (!listings.length) break;

    for (const item of listings) {
      const view = item?.jobview;
      const listingId = view?.job?.listingId;
      if (!listingId) continue;
      const jobUrl = `${BASE}/job-listing/j?jl=${listingId}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);

      const titleText =
        view.job?.jobTitleText || view.header?.jobTitleText || "";
      const company = view.header?.employerNameFromSearch || "";
      const location = view.header?.locationName || "Remote";
      const listingType = (
        view.header?.adOrderSponsorshipLevel || ""
      ).toLowerCase();
      const ageInDays = view.header?.ageInDays;
      let datePosted = "";
      if (typeof ageInDays === "number") {
        if (ageInDays > fromAge) continue;
        const d = new Date();
        d.setDate(d.getDate() - ageInDays);
        datePosted = d.toISOString().slice(0, 10);
      }

      const desc = view.job?.description || "";
      const tmp = document.createElement("div");
      tmp.innerHTML = desc;
      const description = (tmp.textContent || "").replace(/\s+/g, " ").trim();

      jobs.push({
        title: titleText,
        company,
        location,
        site: "glassdoor",
        listing_type: listingType,
        date_posted: datePosted,
        is_remote: "Yes",
        easy_apply: "",
        job_url: jobUrl,
        job_url_direct: "",
        description,
      });
      if (jobs.length >= resultsWanted) break;
    }

    const cursors = resJson?.data?.jobListings?.paginationCursors || [];
    const next = cursors.find((c) => c.pageNumber === page + 1);
    cursor = next?.cursor || null;
    if (!cursor) break;
  }

  return { jobs, rawCount: jobs.length };
}

/**
 * Runs in the ZipRecruiter page context — HTML jobs-search (JobSpy fallback).
 */
async function ziprecruiterPageScrape(args) {
  const { searchTerm, resultsWanted, days, hoursOld } = args;
  // Geo-redirect may land on .ie / .co.uk / etc. — stay on this origin
  const BASE = location.origin;
  const PER_PAGE = 20;
  // ZipRecruiter UI filter only allows 1, 5, 10, 30
  const zrDays = [1, 5, 10, 30].includes(Number(days)) ? Number(days) : 1;

  function parseRelativePosted(text) {
    const s = String(text || "").toLowerCase().replace(/\s+/g, " ");
    const now = Date.now();
    if (/just now|today|minutes? ago|hour(?:s)? ago/.test(s)) {
      return new Date(now).toISOString().slice(0, 10);
    }
    let m = s.match(/(\d+)\s*day(?:s)?\s*ago/);
    if (m) {
      const d = new Date(now - Number(m[1]) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    m = s.match(/(\d+)\s*week(?:s)?\s*ago/);
    if (m) {
      const d = new Date(now - Number(m[1]) * 7 * 86400000);
      return d.toISOString().slice(0, 10);
    }
    m = s.match(/posted\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    if (m) {
      const t = Date.parse(m[1]);
      if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
    }
    return "";
  }

  if (
    /just a moment/i.test(document.title) ||
    /cf-browser-verification|attention required/i.test(
      document.body?.innerText || ""
    )
  ) {
    return {
      error:
        "ZipRecruiter security check is open in a tab. Complete it, then press OK again.",
    };
  }

  const jobs = [];
  const seen = new Set();
  const maxPages = Math.min(25, Math.ceil(resultsWanted / PER_PAGE) + 2);
  const cutoffMs =
    hoursOld && Number(hoursOld) > 0
      ? Date.now() - Number(hoursOld) * 3600 * 1000
      : 0;

  for (let page = 1; page <= maxPages && jobs.length < resultsWanted; page++) {
    const params = new URLSearchParams({
      search: searchTerm || "remote",
      location: "United States",
      remote: "1",
      refine_by_location_type: "only_remote",
      days: String(zrDays),
      page: String(page),
    });

    const paths = ["/jobs-search", "/jobs/search"];
    let html = "";
    let blocked = false;
    let lastStatus = 0;
    for (const path of paths) {
      const res = await fetch(`${BASE}${path}?${params}`, {
        credentials: "include",
        headers: { accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
      });
      lastStatus = res.status;
      html = await res.text();
      if (
        /just a moment/i.test(html.slice(0, 4000)) ||
        /cf-browser-verification/i.test(html.slice(0, 4000))
      ) {
        blocked = true;
        break;
      }
      if (res.ok) break;
      html = "";
    }
    if (blocked) {
      return {
        error: `ZipRecruiter HTTP ${lastStatus || 403} (blocked). Complete the security check in the ZipRecruiter tab, then retry.`,
        jobs,
        rawCount: jobs.length,
      };
    }
    if (!html) break;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const articles = [
      ...doc.querySelectorAll('article[id^="job-card-"]'),
    ];
    if (!articles.length) break;

    for (const art of articles) {
      const cardId = art.id || "";
      const listingKey = cardId.includes("job-card-")
        ? cardId.split("job-card-").pop()
        : "";
      if (!listingKey) continue;

      const jobUrl = `${BASE}/jobs//j?lvk=${listingKey}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);

      const h = art.querySelector("h1, h2, h3");
      let titleText = h?.textContent?.trim() || "";
      if (!titleText) {
        const img = art.querySelector("img[alt]");
        titleText = (img?.getAttribute("alt") || "").trim();
      }

      const company =
        art
          .querySelector('[data-testid="job-card-company"]')
          ?.textContent?.trim() || "";
      const location =
        art
          .querySelector('[data-testid="job-card-location"]')
          ?.textContent?.trim() || "Remote";

      const cardText = art.textContent || "";
      const timeEl = art.querySelector("time[datetime]");
      let datePosted = timeEl?.getAttribute("datetime") || "";
      if (datePosted && datePosted.length >= 10) {
        datePosted = datePosted.slice(0, 10);
      } else {
        datePosted = parseRelativePosted(cardText);
      }

      if (cutoffMs && datePosted) {
        const t = Date.parse(datePosted);
        if (!Number.isNaN(t) && t < cutoffMs) continue;
      }

      jobs.push({
        title: titleText,
        company,
        location,
        site: "zip_recruiter",
        listing_type: "",
        date_posted: datePosted,
        is_remote: "Yes",
        easy_apply: "",
        job_url: jobUrl,
        job_url_direct: "",
        description: "",
      });
      if (jobs.length >= resultsWanted) break;
    }
  }

  return { jobs, rawCount: jobs.length };
}

async function runGlassdoorScrape(payload) {
  try {
    const { tab } = await ensureSiteTab(
      ["https://www.glassdoor.com/*"],
      GD_URL
    );
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: glassdoorPageScrape,
      args: [
        {
          searchTerm: payload.searchTerm || "",
          resultsWanted: payload.resultsWanted || 50,
          fromAge: payload.fromAge || 3,
          query: GLASSDOOR_QUERY,
          fallbackToken: FALLBACK_CSRF,
        },
      ],
    });

    if (!result) return { error: "Glassdoor scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function runZipRecruiterScrape(payload) {
  try {
    const search = encodeURIComponent(payload.searchTerm || "remote");
    const days = payload.days || 1;
    const openUrl = `https://www.ziprecruiter.com/jobs-search?search=${search}&location=United+States&remote=1&refine_by_location_type=only_remote&days=${days}`;
    const { tab } = await ensureSiteTab(
      [
        "https://www.ziprecruiter.com/*",
        "https://www.ziprecruiter.ie/*",
        "https://www.ziprecruiter.co.uk/*",
        "https://www.ziprecruiter.ca/*",
      ],
      openUrl,
      { navigate: true }
    );
    // Wait for possible geo-redirect (.com → .ie etc.)
    await sleep(800);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: ziprecruiterPageScrape,
      args: [
        {
          searchTerm: payload.searchTerm || "",
          resultsWanted: payload.resultsWanted || 50,
          days: payload.days || 1,
          hoursOld: payload.hoursOld || 24,
        },
      ],
    });

    if (!result) return { error: "ZipRecruiter scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Runs in the Jobright page context.
 * Prefers /jobs/search SSR when a keyword is set; falls back to /remote-jobs;
 * paginates swan-api when the user has a session cookie.
 */
async function jobrightPageScrape(args) {
  const { searchTerm, resultsWanted, hoursOld } = args;
  const BASE = "https://jobright.ai";
  const API = "https://swan-api.jobright.ai";

  if (/security check/i.test(document.title)) {
    return {
      error:
        "Jobright security check is open in a tab. Complete it, then press OK again.",
    };
  }

  function toDatePosted(publishTime) {
    if (!publishTime) return "";
    const t = Date.parse(String(publishTime).replace(" ", "T") + "Z");
    if (Number.isNaN(t)) {
      const t2 = Date.parse(String(publishTime));
      if (Number.isNaN(t2)) return String(publishTime).slice(0, 10);
      return new Date(t2).toISOString().slice(0, 10);
    }
    return new Date(t).toISOString().slice(0, 10);
  }

  function normalizeItem(item) {
    const jr = item?.jobResult || item || {};
    const cr = item?.companyResult || {};
    const jobId = jr.jobId || jr.id;
    const title = jr.jobTitle || jr.title || "";
    if (!jobId && !title) return null;

    const isRemote =
      jr.isRemote === true ||
      /remote/i.test(String(jr.workModel || "")) ||
      /remote/i.test(String(jr.jobLocation || ""));

    const locs = Array.isArray(jr.jobLocations)
      ? jr.jobLocations.join(", ")
      : jr.jobLocation || "";

    return {
      title,
      company: cr.companyName || jr.companyName || "",
      location: locs || (isRemote ? "Remote" : ""),
      site: "jobright",
      listing_type: jr.employmentType || "",
      date_posted: toDatePosted(jr.publishTime),
      is_remote: isRemote ? "Yes" : "No",
      easy_apply: "",
      job_url: jobId
        ? `${BASE}/jobs/info/${jobId}`
        : jr.jobUrl || jr.url || "",
      job_url_direct: jr.applyUrl || jr.jobUrlDirect || "",
      description: jr.jobSummary || jr.description || "",
      _isRemote: isRemote,
      _publishMs: jr.publishTime
        ? Date.parse(String(jr.publishTime).replace(" ", "T"))
        : NaN,
    };
  }

  function parseNextData(html) {
    const m = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (!m) return [];
    try {
      const data = JSON.parse(m[1]);
      const pp = data?.props?.pageProps || {};
      const list = pp.defaultData || pp.jobList || [];
      if (!Array.isArray(list)) return [];
      return list.map(normalizeItem).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function fetchHtml(pathAndQuery) {
    const res = await fetch(`${BASE}${pathAndQuery}`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    const html = await res.text();
    if (/security check/i.test(html.slice(0, 2000))) {
      return { blocked: true, html, status: res.status };
    }
    return { blocked: false, html, status: res.status };
  }

  const seen = new Set();
  const jobs = [];
  function addAll(rows) {
    for (const j of rows) {
      if (!j) continue;
      const key = j.job_url || `${j.title}|${j.company}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(j);
    }
  }

  const keyword = (searchTerm || "").trim();

  // 1) Keyword search page (works after CF in a real tab)
  if (keyword) {
    const q = new URLSearchParams({
      titleKeyword: keyword,
      visit: "search",
      location: "United States",
    });
    const { blocked, html, status } = await fetchHtml(`/jobs/search?${q}`);
    if (blocked) {
      return {
        error:
          "Jobright security check blocked search. Complete it in the Jobright tab, then retry.",
        jobs,
        rawCount: jobs.length,
      };
    }
    if (status >= 400) {
      // fall through to remote-jobs
    } else {
      addAll(parseNextData(html));
    }
  }

  // 2) Public remote US listings (SSR, no login)
  if (jobs.length < resultsWanted) {
    const { blocked, html, status } = await fetchHtml("/remote-jobs");
    if (blocked && !jobs.length) {
      return {
        error:
          "Jobright security check is open. Complete it in the Jobright tab, then retry.",
        jobs,
        rawCount: 0,
      };
    }
    if (!blocked && status < 400) {
      addAll(parseNextData(html));
    }
  }

  // 3) Authenticated recommendations pagination (if SESSION_ID cookie exists)
  if (jobs.length < resultsWanted) {
    let position = 0;
    const pageSize = 20;
    let empty = 0;
    while (jobs.length < resultsWanted && empty < 2 && position < 200) {
      const params = new URLSearchParams({
        position: String(position),
        count: String(pageSize),
      });
      if (position === 0) params.set("refresh", "true");
      try {
        const res = await fetch(
          `${API}/swan/recommend/list/jobs?${params}`,
          {
            credentials: "include",
            headers: {
              accept: "application/json",
              origin: BASE,
              referer: `${BASE}/`,
            },
          }
        );
        if (res.status === 401 || res.status === 403) break;
        const data = await res.json();
        if (!data?.success) break;
        const list = data?.result?.jobList || [];
        if (!list.length) {
          empty += 1;
          position += pageSize;
          continue;
        }
        empty = 0;
        addAll(list.map(normalizeItem).filter(Boolean));
        position += pageSize;
      } catch {
        break;
      }
    }
  }

  // Keep remote-only; apply posted-date cutoff when publishTime exists
  const cutoff =
    hoursOld && Number(hoursOld) > 0
      ? Date.now() - Number(hoursOld) * 3600 * 1000
      : 0;

  const filtered = jobs.filter((j) => {
    if (j._isRemote === false) return false;
    if (cutoff && j._publishMs && !Number.isNaN(j._publishMs)) {
      return j._publishMs >= cutoff;
    }
    return true;
  });

  for (const j of filtered) {
    delete j._isRemote;
    delete j._publishMs;
  }

  return { jobs: filtered, rawCount: filtered.length };
}

async function runJobrightScrape(payload) {
  try {
    const keyword = encodeURIComponent(payload.searchTerm || "");
    const openUrl = keyword
      ? `https://jobright.ai/jobs/search?titleKeyword=${keyword}&visit=search&location=United%20States`
      : "https://jobright.ai/remote-jobs";
    const { tab } = await ensureSiteTab(
      ["https://jobright.ai/*", "https://www.jobright.ai/*"],
      openUrl,
      { navigate: true }
    );
    await sleep(1000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: jobrightPageScrape,
      args: [
        {
          searchTerm: payload.searchTerm || "",
          resultsWanted: payload.resultsWanted || 50,
          hoursOld: payload.hoursOld || 24,
        },
      ],
    });

    if (!result) return { error: "Jobright scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Runs in the Dice page context.
 * Parses jobList from Next.js RSC flight scripts on /jobs search pages.
 */
async function dicePageScrape(args) {
  const {
    searchTerm,
    resultsWanted,
    hoursOld,
    postedDate = "ONE",
  } = args;
  const BASE = "https://www.dice.com";
  const PAGE_SIZE = 30;

  if (/just a moment|attention required|security check/i.test(document.title)) {
    return {
      error:
        "Dice security check is open in a tab. Complete it, then press OK again.",
    };
  }

  function extractBalancedObject(text, startIdx) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = startIdx; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(startIdx, j + 1);
      }
    }
    return null;
  }

  function parseJobList(html) {
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const tag of scripts) {
      if (!tag.includes("jobList") || !tag.includes("detailsPageUrl")) continue;
      const body = tag.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
      const m = body.match(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/);
      if (!m) continue;
      let decoded;
      try {
        decoded = JSON.parse(`"${m[1]}"`);
      } catch {
        continue;
      }
      const start = decoded.indexOf('{"jobList"');
      if (start < 0) continue;
      const raw = extractBalancedObject(decoded, start);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        return obj.jobList || null;
      } catch {
        continue;
      }
    }
    return null;
  }

  function toDatePosted(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso).slice(0, 10);
    return new Date(t).toISOString().slice(0, 10);
  }

  function normalizeItem(row) {
    if (!row || typeof row !== "object") return null;
    const title = row.title || "";
    const url = row.detailsPageUrl || "";
    if (!title && !url) return null;

    const workplace = Array.isArray(row.workplaceTypes)
      ? row.workplaceTypes.join(", ")
      : "";
    const isRemote =
      row.isRemote === true ||
      /remote/i.test(workplace) ||
      /remote/i.test(String(row.summary || ""));

    const loc =
      row.jobLocation?.displayName ||
      row.jobLocation?.name ||
      (typeof row.jobLocation === "string" ? row.jobLocation : "") ||
      (isRemote ? "Remote" : workplace) ||
      "Remote";

    const postedMs = row.postedDate ? Date.parse(row.postedDate) : NaN;

    return {
      title,
      company: row.companyName || "",
      location: loc,
      site: "dice",
      listing_type: row.employmentType || "",
      date_posted: toDatePosted(row.postedDate),
      is_remote: isRemote ? "Yes" : "No",
      easy_apply: row.easyApply === true ? "Yes" : row.easyApply === false ? "No" : "",
      job_url: url,
      job_url_direct: row.redirectUrl || "",
      description: row.summary || "",
      _isRemote: isRemote,
      _postedMs: postedMs,
    };
  }

  async function fetchSearchPage(page) {
    const params = new URLSearchParams({
      q: (searchTerm || "").trim(),
      location: "Remote",
      countryCode: "US",
      radius: "30",
      radiusUnit: "mi",
      page: String(page),
      pageSize: String(PAGE_SIZE),
      language: "en",
      "filters.workplaceTypes": "Remote",
      "filters.postedDate": postedDate,
    });
    const res = await fetch(`${BASE}/jobs?${params}`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    const html = await res.text();
    const head = html.slice(0, 2500).toLowerCase();
    if (
      /just a moment|cf-browser-verification|attention required|access denied/.test(
        head
      )
    ) {
      return { blocked: true, html, status: res.status };
    }
    return { blocked: false, html, status: res.status };
  }

  const seen = new Set();
  const jobs = [];
  let page = 1;
  let pageCount = 20;
  let emptyStreak = 0;

  while (jobs.length < resultsWanted && page <= pageCount && emptyStreak < 2) {
    const { blocked, html, status } = await fetchSearchPage(page);
    if (blocked) {
      return {
        error:
          "Dice security check blocked search. Complete it in the Dice tab, then retry.",
        jobs,
        rawCount: jobs.length,
      };
    }
    if (status >= 400) {
      return {
        error: `Dice HTTP ${status}`,
        jobs,
        rawCount: jobs.length,
      };
    }

    const jl = parseJobList(html);
    if (!jl || !Array.isArray(jl.data)) {
      emptyStreak += 1;
      page += 1;
      continue;
    }

    const metaInner = jl.meta?.meta || jl.meta || {};
    if (metaInner.pageCount) pageCount = Number(metaInner.pageCount) || pageCount;

    let added = 0;
    for (const row of jl.data) {
      const j = normalizeItem(row);
      if (!j) continue;
      const key = j.job_url || `${j.title}|${j.company}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(j);
      added += 1;
    }

    if (!added) emptyStreak += 1;
    else emptyStreak = 0;
    page += 1;
  }

  const cutoff =
    hoursOld && Number(hoursOld) > 0
      ? Date.now() - Number(hoursOld) * 3600 * 1000
      : 0;

  const filtered = jobs.filter((j) => {
    if (j._isRemote === false) return false;
    if (cutoff && j._postedMs && !Number.isNaN(j._postedMs)) {
      return j._postedMs >= cutoff;
    }
    return true;
  });

  for (const j of filtered) {
    delete j._isRemote;
    delete j._postedMs;
  }

  return { jobs: filtered, rawCount: filtered.length };
}

async function runDiceScrape(payload) {
  try {
    const q = encodeURIComponent(payload.searchTerm || "");
    const posted = payload.postedDate || "ONE";
    const openUrl =
      `https://www.dice.com/jobs?q=${q}&location=Remote&countryCode=US` +
      `&radius=30&radiusUnit=mi&page=1&pageSize=30` +
      `&filters.workplaceTypes=Remote&filters.postedDate=${posted}&language=en`;
    const { tab } = await ensureSiteTab(
      ["https://www.dice.com/*", "https://dice.com/*"],
      openUrl,
      { navigate: true }
    );
    await sleep(1000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: dicePageScrape,
      args: [
        {
          searchTerm: payload.searchTerm || "",
          resultsWanted: payload.resultsWanted || 50,
          hoursOld: payload.hoursOld || 24,
          postedDate: posted,
        },
      ],
    });

    if (!result) return { error: "Dice scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GLASSDOOR_SCRAPE") {
    runGlassdoorScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "ZIPRECRUITER_SCRAPE") {
    runZipRecruiterScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "JOBRIGHT_SCRAPE") {
    runJobrightScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "DICE_SCRAPE") {
    runDiceScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  console.info(
    "JobBridge Fetch ready (Glassdoor / ZipRecruiter / Jobright / Dice use site tabs)."
  );
});
