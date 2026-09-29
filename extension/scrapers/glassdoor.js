/**
 * Glassdoor via a real browser tab (page-context fetch).
 * Extension-origin requests are Cloudflare-403'd; same-origin from
 * www.glassdoor.com works after the tab loads.
 */

import { resolveDatePreset, filterByTitle, filterByHoursOld } from "./util.js";

/**
 * @param {{
 *   searchTerm: string,
 *   title?: string,
 *   resultsWanted: number,
 *   datePreset?: string,
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeGlassdoor({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Glassdoor: opening site tab (bypasses Cloudflare)…");

  const response = await chrome.runtime.sendMessage({
    type: "GLASSDOOR_SCRAPE",
    payload: {
      searchTerm: (title || searchTerm || "").trim() || "remote",
      title: (title || "").trim(),
      resultsWanted,
      fromAge: preset.glassdoorFromAge,
      datePresetLabel: preset.label,
    },
  });

  if (!response) {
    throw new Error("Glassdoor: no response from extension background");
  }
  if (response.error && !(response.jobs && response.jobs.length)) {
    throw new Error(response.error);
  }

  const titleFilter = (title || "").trim();
  let jobs = response.jobs || [];
  jobs = filterByTitle(filterByHoursOld(jobs, preset.hoursOld), titleFilter);
  onProgress?.(
    `Glassdoor: ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  return jobs.slice(0, resultsWanted);
}
