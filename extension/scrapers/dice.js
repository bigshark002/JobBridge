/**
 * Dice.com via a real browser tab.
 * Search HTML embeds Next.js RSC flight data with jobList; extension-origin
 * fetches can be blocked, so scrape runs in page context (Jobright pattern).
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
export async function scrapeDice({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Dice: opening site tab…");

  const response = await chrome.runtime.sendMessage({
    type: "DICE_SCRAPE",
    payload: {
      searchTerm: (title || searchTerm || "").trim(),
      resultsWanted: Math.min(200, Math.max(resultsWanted * 3, resultsWanted)),
      hoursOld: preset.hoursOld,
      postedDate: preset.dicePostedDate || "ONE",
      datePresetLabel: preset.label,
    },
  });

  if (!response) {
    throw new Error("Dice: no response from extension background");
  }
  if (response.error && !(response.jobs && response.jobs.length)) {
    throw new Error(response.error);
  }

  const titleFilter = (title || "").trim();
  let jobs = response.jobs || [];
  jobs = filterByTitle(filterByHoursOld(jobs, preset.hoursOld), titleFilter);
  onProgress?.(
    `Dice: ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  return jobs.slice(0, resultsWanted);
}
