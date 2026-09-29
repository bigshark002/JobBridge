/** Shared helpers for JobBridge extension scrapers. */

export const DATE_PRESETS = {
  today: {
    id: "today",
    label: "Today (24 hours)",
    hoursOld: 24,
    wellfound: "today",
    glassdoorFromAge: 1,
    // ZipRecruiter HTML only accepts 1 | 5 | 10 | 30 (not 3)
    ziprecruiterDays: 1,
    // Dice filters.postedDate facet values
    dicePostedDate: "ONE",
  },
  "3days": {
    id: "3days",
    label: "3 days (72 hours)",
    hoursOld: 72,
    wellfound: "3days",
    glassdoorFromAge: 3,
    // nearest allowed ZR value that covers ~72h
    ziprecruiterDays: 5,
    dicePostedDate: "THREE",
  },
};

export function resolveDatePreset(id) {
  return DATE_PRESETS[id] || DATE_PRESETS.today;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stripHtml(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

export function formatLocation(parts) {
  return parts.filter(Boolean).join(", ");
}

export function tokenizeQuery(q) {
  return String(q || "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1);
}

/** Require every title token to appear in the job title. */
export function filterByTitle(jobs, title) {
  const tokens = tokenizeQuery(title);
  if (!tokens.length) return jobs;
  return jobs.filter((j) => {
    const blob = String(j.title || "").toLowerCase();
    return tokens.every((t) => blob.includes(t));
  });
}

export function filterByStack(jobs, stack) {
  const tokens = tokenizeQuery(stack);
  if (!tokens.length) return jobs;
  return jobs.filter((j) => {
    const blob = `${j.title || ""} ${j.description || ""}`.toLowerCase();
    return tokens.every((t) => blob.includes(t));
  });
}

/** Keep jobs whose date_posted is within hoursOld (when a parseable date exists). */
export function filterByHoursOld(jobs, hoursOld) {
  if (!hoursOld) return jobs;
  const cutoff = Date.now() - hoursOld * 3600 * 1000;
  return jobs.filter((j) => {
    if (!j.date_posted) return true; // keep if board didn't expose a date
    const t = Date.parse(j.date_posted);
    if (Number.isNaN(t)) return true;
    return t >= cutoff;
  });
}

export function normalizeJob(partial) {
  const isRemote = partial.is_remote;
  const easyApply = partial.easy_apply;
  return {
    title: partial.title || "",
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
    easy_apply:
      easyApply === true || easyApply === "Yes"
        ? "Yes"
        : easyApply === false || easyApply === "No"
          ? "No"
          : partial.easy_apply || "",
    job_url: partial.job_url || "",
    job_url_direct: partial.job_url_direct || "",
    description: partial.description || "",
  };
}

/** Detect remote from title / location / description text. */
export function detectRemote(...parts) {
  const blob = parts.filter(Boolean).join(" ").toLowerCase();
  return /\b(remote|work from home|\bwfh\b)\b/i.test(blob);
}
