import { scrapeG2i } from "./ashby.js";
import { scrapeLinkedIn } from "./linkedin.js";
import { scrapeDjinni } from "./djinni.js";
import { scrapeNodesk } from "./nodesk.js";
import { scrapeRemoteRocketship } from "./remoterocketship.js";
import { scrapeRemoteYeah } from "./remoteyeah.js";
import { scrapeSimplyHired } from "./simplyhired.js";
import { filterByStack, filterByTitle, resolveDatePreset } from "./util.js";
import { scrapeWorkable } from "./workable.js";

const SCRAPERS = {
  djinni: scrapeDjinni,
  workable: scrapeWorkable,
  remoteyeah: scrapeRemoteYeah,
  simplyhired: scrapeSimplyHired,
  remoterocketship: scrapeRemoteRocketship,
  nodesk: scrapeNodesk,
  g2i: scrapeG2i,
  linkedin: scrapeLinkedIn,
};

/**
 * Fully remote jobs workable from the EU or UK.
 */
export async function scrapeJobs({
  sites,
  title,
  stack,
  count,
  datePreset,
  rocketshipApiKey,
  onProgress,
}) {
  const titleQ = (title || "").trim();
  const stackQ = (stack || "").trim();
  if (!sites?.length) throw new Error("Select at least one platform");

  const preset = resolveDatePreset(datePreset);
  const resultsWanted = Math.max(1, Math.min(200, Number(count) || 50));
  const all = [];
  const errors = [];

  for (const site of sites) {
    const fn = SCRAPERS[site];
    if (!fn) {
      errors.push(`Unknown platform: ${site}`);
      continue;
    }
    try {
      onProgress?.(`Fetching ${site}…`);
      const jobs = await fn({
        title: titleQ,
        stack: stackQ,
        resultsWanted,
        datePreset: preset.id,
        rocketshipApiKey,
        onProgress,
      });
      all.push(...jobs);
      onProgress?.(`${site}: ${jobs.length} job(s)`);
    } catch (err) {
      const msg = err?.message || String(err);
      errors.push(`${site}: ${msg}`);
      onProgress?.(`${site} failed: ${msg}`);
    }
  }

  let jobs = filterByTitle(all, titleQ);
  jobs = filterByStack(jobs, stackQ);

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, " ")
      .trim();
  const seen = new Set();
  jobs = jobs.filter((j) => {
    const titleKey = norm(j.title);
    const company = norm(j.company);
    const key = titleKey && company ? `${titleKey}|${company}` : j.job_url;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { jobs, errors, datePreset: preset };
}
