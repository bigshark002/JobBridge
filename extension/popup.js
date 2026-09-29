const form = document.getElementById("fetch-form");
const statusEl = document.getElementById("status");
const okBtn = document.getElementById("ok-btn");

const STORAGE_KEYS = ["title", "stack", "count", "sites", "date_preset"];

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function selectedSites() {
  return [...form.querySelectorAll('input[name="site"]:checked')].map(
    (el) => el.value
  );
}

async function restoreForm() {
  const saved = await chrome.storage.local.get(STORAGE_KEYS);
  if (saved.title) form.title.value = saved.title;
  if (saved.stack) form.stack.value = saved.stack;
  if (saved.count) form.count.value = String(saved.count);
  if (saved.date_preset === "today" || saved.date_preset === "3days") {
    form.date_preset.value = saved.date_preset;
  }
  if (Array.isArray(saved.sites) && saved.sites.length) {
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
  const datePreset =
    form.date_preset.value === "3days" ? "3days" : "today";
  const sites = selectedSites();

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
    pendingFetch: { title, stack, count, sites, datePreset },
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL("runner.html"),
  });

  window.close();
});

restoreForm();
