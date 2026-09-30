const form = document.getElementById("fetch-form");
const statusEl = document.getElementById("status");
const okBtn = document.getElementById("ok-btn");

const STORAGE_KEYS = ["title", "stack", "count", "sites", "date_preset", "rocketship_api_key"];

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function selectedSites() {
  return [...form.querySelectorAll('input[name="site"]:checked')].map((el) => el.value);
}

async function restoreForm() {
  const saved = await chrome.storage.local.get(STORAGE_KEYS);
  if (saved.title) form.title.value = saved.title;
  if (saved.stack) form.stack.value = saved.stack;
  if (saved.count) form.count.value = String(saved.count);
  if (saved.date_preset === "1" || saved.date_preset === "2" || saved.date_preset === "3") {
    form.date_preset.value = saved.date_preset;
  }
  if (saved.rocketship_api_key) form.rocketship_api_key.value = saved.rocketship_api_key;
  const known = new Set([...form.querySelectorAll('input[name="site"]')].map((el) => el.value));
  if (Array.isArray(saved.sites) && saved.sites.some((site) => known.has(site))) {
    form.querySelectorAll('input[name="site"]').forEach((el) => {
      el.checked = saved.sites.includes(el.value);
    });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = form.title.value.trim();
  const stack = form.stack.value.trim();
  const count = Math.max(1, Math.min(200, Number(form.count.value) || 50));
  const datePreset = ["1", "2", "3"].includes(form.date_preset.value)
    ? form.date_preset.value
    : "1";
  const sites = selectedSites();
  const rocketshipApiKey = form.rocketship_api_key.value.trim();

  if (!sites.length) {
    setStatus("Select at least one platform.", "error");
    return;
  }

  okBtn.disabled = true;
  setStatus("Opening fetch tab…");

  await chrome.storage.local.set({
    title,
    stack,
    count,
    sites,
    date_preset: datePreset,
    rocketship_api_key: rocketshipApiKey,
    pendingFetch: {
      title,
      stack,
      count,
      sites,
      datePreset,
      rocketshipApiKey,
    },
  });

  await chrome.tabs.create({ url: chrome.runtime.getURL("runner.html") });
  window.close();
});

restoreForm();
