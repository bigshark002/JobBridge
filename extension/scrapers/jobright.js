/**
 * Jobright.ai via a real browser tab.
 * Public /remote-jobs has SSR jobs; /jobs/search is CF-gated from extension
 * origin, so scraping runs in page context (same pattern as Glassdoor).
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
export async function scrapeJobright({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Jobright: opening site tab…");

  const response = await chrome.runtime.sendMessage({
    type: "JOBRIGHT_SCRAPE",
    payload: {
      searchTerm: (title || searchTerm || "").trim(),
      resultsWanted: Math.min(200, Math.max(resultsWanted * 3, resultsWanted)),
      hoursOld: preset.hoursOld,
      datePresetLabel: preset.label,
    },
  });

  if (!response) {
    throw new Error("Jobright: no response from extension background");
  }
  if (response.error && !(response.jobs && response.jobs.length)) {
    throw new Error(response.error);
  }

  const titleFilter = (title || "").trim();
  let jobs = response.jobs || [];
  jobs = filterByTitle(filterByHoursOld(jobs, preset.hoursOld), titleFilter);
  onProgress?.(
    `Jobright: ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  return jobs.slice(0, resultsWanted);
}
