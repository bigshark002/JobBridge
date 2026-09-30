/** Shared helpers for the EU+UK extension. */

import "./title-match.js";

export const DATE_PRESETS = {
  1: { id: "1", days: 1, label: "1 day", hoursOld: 24 },
  2: { id: "2", days: 2, label: "2 days", hoursOld: 48 },
  3: { id: "3", days: 3, label: "3 days", hoursOld: 72 },
};

export function resolveDatePreset(id) {
  return DATE_PRESETS[String(id)] || DATE_PRESETS[1];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function titleMatches(jobTitle, title) {
  return globalThis.jbTitleMatches(jobTitle, title);
}

export function filterByTitle(jobs, title) {
  if (!String(title || "").trim()) return jobs;
  return jobs.filter((j) => titleMatches(j.title, title));
}

export function filterByStack(jobs, stack) {
  const tokens = String(stack || "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1);
  if (!tokens.length) return jobs;
  return jobs.filter((j) => {
    const blob = `${j.title || ""} ${j.description || ""}`.toLowerCase();
    return tokens.every((t) => blob.includes(t));
  });
}

export function withinHours(datePosted, hoursOld) {
  if (!hoursOld || !datePosted) return true;
  const s = String(datePosted).trim();
  const t = Date.parse(s);
  if (Number.isNaN(t)) return true;
  const cutoff = Date.now() - hoursOld * 3600 * 1000;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
    return s >= cutoffDay;
  }
  return t >= cutoff;
}

export function filterByHoursOld(jobs, hoursOld) {
  if (!hoursOld) return jobs;
  return jobs.filter((j) => withinHours(j.date_posted, hoursOld));
}

export function toDateOnly(value) {
  if (!value) return "";
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return String(value).slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

export function normalizeJob(partial) {
  const isRemote = partial.is_remote;
  return {
    title: stripHtml(partial.title || ""),
    company: partial.company || "",
    location: partial.location || "",
    site: partial.site || "",
    listing_type: partial.listing_type || "",
    date_posted: partial.date_posted || "",
    is_remote:
      isRemote === true || isRemote === "Yes"
        ? "Yes"
        : isRemote === false || isRemote === "No"
          ? "No"
          : partial.is_remote || "",
    country: partial.country || "",
    job_url: partial.job_url || "",
    job_url_direct: partial.job_url_direct || "",
    description: partial.description || "",
  };
}
