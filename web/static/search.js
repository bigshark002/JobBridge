(function () {
  const PAGE_SIZE = 15;

  const form = document.getElementById("search-form");
  const searchInput = document.getElementById("search_term");
  const searchClearBtn = document.getElementById("search-clear");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const jobsBody = document.getElementById("jobs-body");
  const emptyState = document.getElementById("empty-state");
  const submitBtn = document.getElementById("submit-btn");
  const btnText = submitBtn.querySelector(".btn-text");
  const btnSpinner = submitBtn.querySelector(".btn-spinner");
  const countrySelect = document.getElementById("country-select");
  const datePresetSelect = document.getElementById("date_preset");
  const wwHint = document.getElementById("ww-hint");
  const resultCount = document.getElementById("result-count");
  const paginationEl = document.getElementById("pagination");
  const pagePrev = document.getElementById("page-prev");
  const pageNext = document.getElementById("page-next");
  const pageInfo = document.getElementById("page-info");

  let allJobs = [];
  let currentPage = 1;
  /** @type {{ jobs: object[], page: number } | null} */
  let snapshotBeforeSearch = null;

  function getSelectedSites() {
    return Array.from(form.querySelectorAll(".platform-site-cb:checked"))
      .filter(function (cb) {
        return !cb.disabled;
      })
      .map(function (cb) {
        return cb.value;
      });
  }

  function isWorldwideScope() {
    if (!countrySelect) return false;
    const v = countrySelect.value;
    return v === "WW" || v === "";
  }

  function syncPlatformsWithCountry() {
    const gd = document.getElementById("platform-glassdoor");
    if (!gd || !countrySelect) return;
    if (isWorldwideScope()) {
      gd.checked = false;
      gd.disabled = true;
    } else {
      gd.disabled = false;
    }
    if (getSelectedSites().length === 0) {
      const li = document.getElementById("platform-linkedin");
      const ind = document.getElementById("platform-indeed");
      const wf = document.getElementById("platform-wellfound");
      if (li) li.checked = true;
      if (ind) ind.checked = true;
      if (wf) wf.checked = true;
    }
  }

  function updateWwHint() {
    if (wwHint) wwHint.hidden = !isWorldwideScope();
    syncPlatformsWithCountry();
  }

  function formatSitesForStatus(sites) {
    const labels = {
      linkedin: "LinkedIn",
      indeed: "Indeed",
      wellfound: "Wellfound",
      glassdoor: "Glassdoor",
    };
    const parts = sites.map(function (s) {
      return labels[s] || s;
    });
    if (parts.length === 0) return "job boards";
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] + " and " + parts[1];
    return parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1];
  }

  function updateSearchClearVisibility() {
    if (!searchClearBtn || !searchInput) return;
    const has = Boolean((searchInput.value || "").trim());
    searchClearBtn.hidden = !has;
  }

  if (searchInput && searchClearBtn) {
    function syncClearAfterKeywordChange() {
      updateSearchClearVisibility();
    }
    ["input", "change", "keyup", "paste", "cut", "blur"].forEach(function (ev) {
      searchInput.addEventListener(ev, syncClearAfterKeywordChange);
    });
    searchInput.addEventListener("focus", function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(syncClearAfterKeywordChange);
      });
    });
    searchClearBtn.addEventListener("click", function () {
      searchInput.value = "";
      updateSearchClearVisibility();
      searchInput.focus();
    });
    updateSearchClearVisibility();
  }

  function safeHttpUrl(u) {
    if (!u || typeof u !== "string") return "";
    const t = u.trim();
    if (!t || t.toLowerCase() === "nan") return "";
    try {
      const p = new URL(t);
      return p.protocol === "http:" || p.protocol === "https:" ? t : "";
    } catch {
      return "";
    }
  }

  function linkUrl(job) {
    const d = safeHttpUrl(job.job_url_direct);
    if (d) return d;
    return safeHttpUrl(job.job_url);
  }

  const defaultBtnLabel = btnText ? btnText.textContent : "Search";

  function setLoading(loading) {
    submitBtn.disabled = loading;
    if (btnSpinner) btnSpinner.hidden = !loading;
    if (btnText) btnText.textContent = loading ? "Searching…" : defaultBtnLabel;
  }

  function showIdlePlaceholder() {
    jobsBody.innerHTML = "";
    const tr = document.createElement("tr");
    tr.className = "jobs-placeholder";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "jobs-placeholder-cell";
    td.textContent =
      "Run a search to load roles. Matches are shown here, 15 per page.";
    tr.appendChild(td);
    jobsBody.appendChild(tr);
    if (paginationEl) paginationEl.hidden = true;
  }

  function showSearchingPlaceholder() {
    jobsBody.innerHTML = "";
    const tr = document.createElement("tr");
    tr.className = "jobs-placeholder";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "jobs-placeholder-cell";
    td.textContent = "Searching…";
    tr.appendChild(td);
    jobsBody.appendChild(tr);
    if (paginationEl) paginationEl.hidden = true;
  }

  async function loadCountries() {
    countrySelect.innerHTML = "";
    const r = await fetch("/api/countries");
    if (!r.ok) throw new Error("Could not load countries");
    const data = await r.json();
    if (data && typeof data === "object" && data.error) {
      throw new Error(data.error);
    }
    if (!Array.isArray(data)) {
      throw new Error("Invalid countries response");
    }
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "Anywhere (no country)";
    countrySelect.appendChild(emptyOpt);
    for (const c of data) {
      if (!c || !c.cca2) continue;
      const opt = document.createElement("option");
      opt.value = c.cca2;
      opt.textContent = c.name != null ? String(c.name) : c.cca2;
      countrySelect.appendChild(opt);
    }
    const hasUs = Array.from(countrySelect.options).some(function (o) {
      return o.value === "US";
    });
    countrySelect.value = hasUs ? "US" : countrySelect.options[0]?.value || "";
    updateWwHint();
  }

  function siteLabel(site) {
    if (site == null) return "";
    return String(site)
      .split("_")
      .map(function (w) {
        return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : "";
      })
      .join(" ");
  }

  function appendJobRow(job) {
    const tr = document.createElement("tr");
    const href = linkUrl(job);

    const tdTitle = document.createElement("td");
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = job.title != null ? String(job.title) : "";
      tdTitle.appendChild(a);
    } else {
      tdTitle.textContent = job.title != null ? String(job.title) : "";
    }

    const tdCo = document.createElement("td");
    tdCo.textContent = job.company != null ? String(job.company) : "";
    const tdLoc = document.createElement("td");
    tdLoc.textContent = job.location != null ? String(job.location) : "";

    const tdSite = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "site-pill";
    pill.textContent = siteLabel(job.site);
    tdSite.appendChild(pill);

    const tdList = document.createElement("td");
    tdList.textContent =
      job.listing_type != null && String(job.listing_type) !== "nan"
        ? String(job.listing_type)
        : "—";

    const tdLinks = document.createElement("td");
    const jobUrl = safeHttpUrl(job.job_url);
    const direct = safeHttpUrl(job.job_url_direct);
    if (direct && direct !== jobUrl) {
      const a1 = document.createElement("a");
      a1.href = direct;
      a1.target = "_blank";
      a1.rel = "noopener";
      a1.textContent = "Apply";
      tdLinks.appendChild(a1);
      if (jobUrl) {
        tdLinks.appendChild(document.createTextNode(" · "));
        const a2 = document.createElement("a");
        a2.href = jobUrl;
        a2.target = "_blank";
        a2.rel = "noopener";
        a2.textContent = "Board";
        tdLinks.appendChild(a2);
      }
    } else if (jobUrl) {
      const a = document.createElement("a");
      a.href = jobUrl;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open";
      tdLinks.appendChild(a);
    } else {
      tdLinks.textContent = "—";
    }

    tr.appendChild(tdTitle);
    tr.appendChild(tdCo);
    tr.appendChild(tdLoc);
    tr.appendChild(tdSite);
    tr.appendChild(tdList);
    tr.appendChild(tdLinks);
    jobsBody.appendChild(tr);
  }

  function updatePaginationUi() {
    if (!paginationEl || !pagePrev || !pageNext || !pageInfo) return;
    const n = allJobs.length;
    const totalPages = Math.max(1, Math.ceil(n / PAGE_SIZE));
    pageInfo.textContent =
      "Page " +
      currentPage +
      " of " +
      totalPages +
      " · " +
      n +
      (n === 1 ? " role" : " roles");
    pagePrev.disabled = currentPage <= 1;
    pageNext.disabled = currentPage >= totalPages;
    paginationEl.hidden = n === 0 || totalPages <= 1;
  }

  function renderCurrentPage() {
    jobsBody.innerHTML = "";
    const n = allJobs.length;
    const totalPages = Math.max(1, Math.ceil(n / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const slice = allJobs.slice(start, start + PAGE_SIZE);
    for (const job of slice) {
      appendJobRow(job);
    }
    updatePaginationUi();
  }

  function renderJobs(jobs) {
    allJobs = Array.isArray(jobs) ? jobs : [];
    currentPage = 1;
    const n = allJobs.length;
    resultCount.textContent = n === 1 ? "1 role" : n + " roles";
    resultCount.hidden = false;

    if (n === 0) {
      jobsBody.innerHTML = "";
      emptyState.hidden = false;
      if (paginationEl) paginationEl.hidden = true;
      return;
    }

    emptyState.hidden = true;
    renderCurrentPage();
  }

  function restoreSnapshot() {
    if (!snapshotBeforeSearch) {
      showIdlePlaceholder();
      resultCount.hidden = true;
      return;
    }
    allJobs = snapshotBeforeSearch.jobs;
    currentPage = snapshotBeforeSearch.page;
    snapshotBeforeSearch = null;
    const n = allJobs.length;
    if (n === 0) {
      showIdlePlaceholder();
      resultCount.hidden = true;
      return;
    }
    resultCount.textContent = n === 1 ? "1 role" : n + " roles";
    resultCount.hidden = false;
    emptyState.hidden = true;
    renderCurrentPage();
  }

  if (pagePrev) {
    pagePrev.addEventListener("click", function () {
      if (currentPage > 1) {
        currentPage -= 1;
        renderCurrentPage();
        const wrap = document.querySelector(".table-scroll");
        if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }
  if (pageNext) {
    pageNext.addEventListener("click", function () {
      const totalPages = Math.max(1, Math.ceil(allJobs.length / PAGE_SIZE));
      if (currentPage < totalPages) {
        currentPage += 1;
        renderCurrentPage();
        const wrap = document.querySelector(".table-scroll");
        if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    errorEl.hidden = true;
    errorEl.textContent = "";
    emptyState.hidden = true;

    const fd = new FormData(form);
    const datePreset = datePresetSelect ? datePresetSelect.value : "today";
    const sites = getSelectedSites();
    const ccRaw = countrySelect.value;
    if (ccRaw === "__loading__") {
      errorEl.textContent = "Please wait for the country list to finish loading.";
      errorEl.hidden = false;
      return;
    }
    const country_cca2 =
      ccRaw === "" ? "" : (ccRaw || "US").trim().toUpperCase();
    const payload = {
      search_term: (fd.get("search_term") || "").trim(),
      date_preset: datePreset,
      country_cca2: country_cca2,
      is_remote: document.getElementById("is_remote").checked,
      results_wanted: 100,
      sites: sites,
    };

    if (!payload.search_term) {
      errorEl.textContent = "Please enter keywords to search.";
      errorEl.hidden = false;
      return;
    }

    if (!sites.length) {
      errorEl.textContent = "Select at least one job platform.";
      errorEl.hidden = false;
      return;
    }

    snapshotBeforeSearch =
      allJobs.length > 0
        ? { jobs: allJobs.slice(), page: currentPage }
        : null;
    showSearchingPlaceholder();

    setLoading(true);
    statusEl.textContent =
      "Searching " +
      formatSitesForStatus(sites) +
      " — this may take a few minutes.";

    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, 600000);

    try {
      const r = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) {
        throw new Error(data.error || r.statusText || "Search failed");
      }
      snapshotBeforeSearch = null;
      const count = data.count || 0;
      statusEl.textContent = count
        ? "Search complete. Review results below."
        : "Search complete — no matching roles were returned.";
      renderJobs(data.jobs || []);
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        errorEl.textContent =
          "The request timed out (10 minute limit). Try fewer sources or narrower terms.";
      } else {
        errorEl.textContent = err.message || String(err);
      }
      errorEl.hidden = false;
      statusEl.textContent = "";
      restoreSnapshot();
    } finally {
      setLoading(false);
      updateSearchClearVisibility();
    }
  });

  countrySelect.addEventListener("change", updateWwHint);

  syncPlatformsWithCountry();

  loadCountries().catch(function (err) {
    errorEl.textContent = err.message || "Failed to load countries.";
    errorEl.hidden = false;
    countrySelect.innerHTML =
      '<option value="">Anywhere (no country)</option><option value="WW">Worldwide</option><option value="US" selected>United States</option>';
    updateWwHint();
  });
})();
