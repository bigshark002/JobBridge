"""
JobSpy web UI — search LinkedIn, Indeed, Wellfound, Glassdoor.
Run from repo root:  python -m web.app
Or:  flask --app web.app run --debug
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
import pandas as pd
import requests
from flask import Flask, jsonify, render_template, request

from jobspy import scrape_jobs
from jobspy.model import Country

logger = logging.getLogger(__name__)

ROOT = __file__.rsplit("/", 1)[0]
app = Flask(
    __name__,
    template_folder=f"{ROOT}/templates",
    static_folder=f"{ROOT}/static",
)

# Prefer JobSpy-friendly slugs where ISO codes differ from from_string() aliases
CCA2_TO_JOBSPY = {
    "US": "usa",
    "GB": "uk",
}


def _country_for_jobspy(cca2: str, name_common: str) -> str:
    u = cca2.upper()
    if u == "WW":
        return "worldwide"
    if u in CCA2_TO_JOBSPY:
        return CCA2_TO_JOBSPY[u]
    s = (name_common or "").strip().lower()
    if not s:
        return "usa"
    try:
        Country.from_string(s)
        return s
    except ValueError:
        return s.replace(" ", "") or "usa"


_COUNTRIES_PAYLOAD: tuple[float, list[dict]] = (0.0, [])
_COUNTRIES_STATIC_PATH = f"{ROOT}/data/countries.json"


def _normalize_country_rows(raw: list) -> list[dict]:
    out: list[dict] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        cca2 = (row.get("cca2") or "").strip().upper()
        name_val = row.get("name")
        if isinstance(name_val, dict):
            name = (name_val.get("common") or "").strip()
        else:
            name = (name_val or "").strip()
        if not cca2 or not name or cca2 == "WW":
            continue
        out.append(
            {
                "cca2": cca2,
                "name": name,
                "jobspy_country": _country_for_jobspy(cca2, name),
            }
        )
    out.sort(key=lambda x: x["name"].lower())
    out.insert(
        0,
        {"cca2": "WW", "name": "Worldwide", "jobspy_country": "worldwide"},
    )
    return out


def _load_countries_from_static() -> list[dict]:
    with open(_COUNTRIES_STATIC_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        raise ValueError("Static countries file has unexpected shape")
    return _normalize_country_rows(raw)


def get_countries() -> list[dict]:
    """Load country list (local JSON; remote API is optional and often unavailable)."""
    global _COUNTRIES_PAYLOAD
    now = datetime.now(timezone.utc).timestamp()
    ts, data = _COUNTRIES_PAYLOAD
    if data and now - ts < 86400:
        return data

    # restcountries.com retired free v3.1; prefer bundled data so search never breaks.
    try:
        out = _load_countries_from_static()
        _COUNTRIES_PAYLOAD = (now, out)
        return out
    except Exception:
        logger.exception("failed to load static countries; trying remote fallback")

    url = "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json"
    r = requests.get(url, timeout=45)
    r.raise_for_status()
    raw = r.json()
    if not isinstance(raw, list):
        raise ValueError("Countries API returned unexpected shape")
    out = _normalize_country_rows(raw)
    _COUNTRIES_PAYLOAD = (now, out)
    return out


DATE_PRESETS = {
    "today": {"hours_old": 24, "wellfound_date_posted": "today"},
    "3days": {"hours_old": 72, "wellfound_date_posted": "3days"},
    "week": {"hours_old": 168, "wellfound_date_posted": "week"},
}

RESULT_COLS = [
    "job_url",
    "job_url_direct",
    "title",
    "company",
    "location",
    "site",
    "listing_type",
    "description",
]

# Platforms exposed in the web UI (order = default when client omits `sites`)
WEB_SEARCH_SITES: tuple[str, ...] = ("linkedin", "indeed", "wellfound", "glassdoor")
WEB_SEARCH_SITES_SET = frozenset(WEB_SEARCH_SITES)


def parse_requested_sites(body: dict, cca2: str) -> tuple[list[str] | None, str | None]:
    """Resolve site list from JSON body. Worldwide cannot use Glassdoor."""
    raw = body.get("sites")
    if raw is None:
        sites = list(WEB_SEARCH_SITES)
    else:
        if not isinstance(raw, list):
            return None, "sites must be a JSON array of platform ids"
        sites = []
        seen: set[str] = set()
        for x in raw:
            if isinstance(x, str):
                s = x.strip().lower()
                if s in WEB_SEARCH_SITES_SET and s not in seen:
                    seen.add(s)
                    sites.append(s)
        if not sites:
            return None, "Select at least one job platform"
    if cca2 == "WW":
        sites = [s for s in sites if s != "glassdoor"]
    if not sites:
        return (
            None,
            "Worldwide search cannot use Glassdoor. Select at least one other platform.",
        )
    return sites, None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/countries")
def api_countries():
    try:
        countries = get_countries()
        return jsonify(countries)
    except Exception as e:
        logger.exception("countries fetch failed")
        return jsonify({"error": str(e)}), 502


def _jobs_dataframe_to_records(df: pd.DataFrame) -> list[dict]:
    if df is None or df.empty:
        return []
    for c in RESULT_COLS:
        if c not in df.columns:
            df[c] = None
    return json.loads(df[RESULT_COLS].copy().to_json(orient="records"))


def _filter_jobs_by_stack(records: list[dict], stack: str) -> list[dict]:
    """Keep rows whose title/description mention every stack token."""
    tokens = [t.strip().lower() for t in stack.replace(",", " ").split() if t.strip()]
    if not tokens:
        return records
    out: list[dict] = []
    for row in records:
        blob = f"{row.get('title') or ''} {row.get('description') or ''}".lower()
        if all(tok in blob for tok in tokens):
            out.append(row)
    return out


@app.after_request
def _cors_for_extension(resp):
    """Allow Chrome extension + local UI to call the API."""
    origin = request.headers.get("Origin") or ""
    if (
        origin.startswith("chrome-extension://")
        or origin.startswith("http://127.0.0.1:")
        or origin.startswith("http://localhost:")
    ):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Vary"] = "Origin"
    return resp


@app.route("/api/search", methods=["OPTIONS"])
@app.route("/api/extension/search", methods=["OPTIONS"])
def api_options():
    return ("", 204)


@app.post("/api/search")
def api_search():
    body = request.get_json(silent=True) or {}
    search_term = (body.get("search_term") or "").strip()
    if not search_term:
        return jsonify({"error": "search_term is required"}), 400

    date_preset = (body.get("date_preset") or "today").lower()
    if date_preset not in DATE_PRESETS:
        date_preset = "today"
    date_cfg = DATE_PRESETS[date_preset]

    raw_cc = body.get("country_cca2")
    if raw_cc is None:
        cca2 = "US"
        use_anywhere = False
    elif isinstance(raw_cc, str) and raw_cc.strip() == "":
        use_anywhere = True
        cca2 = None
    else:
        use_anywhere = False
        cca2 = str(raw_cc).strip().upper()

    is_remote = bool(body.get("is_remote"))
    results_wanted = int(body.get("results_wanted") or 50)
    results_wanted = max(5, min(results_wanted, 100))

    try:
        countries = get_countries()
        if use_anywhere:
            country_indeed = "worldwide"
            location_label = None
            sites_scope = "WW"
        else:
            row = next((c for c in countries if c["cca2"].upper() == cca2), None)
            if not row:
                return jsonify({"error": "Unknown country"}), 400
            country_indeed = row["jobspy_country"]
            location_label = row["name"] if cca2 != "WW" else None
            sites_scope = cca2
    except Exception as e:
        logger.exception("country resolution failed")
        return jsonify({"error": f"Country list unavailable: {e}"}), 502

    sites, sites_err = parse_requested_sites(body, sites_scope)
    if sites_err:
        return jsonify({"error": sites_err}), 400

    try:
        df = scrape_jobs(
            site_name=sites,
            search_term=search_term,
            location=location_label,
            is_remote=is_remote,
            results_wanted=results_wanted,
            country_indeed=country_indeed,
            hours_old=date_cfg["hours_old"],
            wellfound_date_posted=date_cfg["wellfound_date_posted"],
            wellfound_country_name=(
                "all" if country_indeed == "worldwide" else None
            ),
            linkedin_fetch_description=False,
            verbose=0,
            request_timeout=120,
        )
    except Exception as e:
        logger.exception("scrape_jobs failed")
        return jsonify({"error": str(e)}), 500

    records = _jobs_dataframe_to_records(df)
    return jsonify({"jobs": records, "count": len(records)})


@app.post("/api/extension/search")
def api_extension_search():
    """
    Chrome extension endpoint: remote-only US jobs.
    LinkedIn is scraped without easy_apply (f_AL) so results are not
    limited to Easy Apply listings.
    """
    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    stack = (body.get("stack") or "").strip()
    if not title and not stack:
        return jsonify({"error": "title or stack is required"}), 400

    search_term = " ".join(p for p in (title, stack) if p).strip()

    results_wanted = int(body.get("results_wanted") or body.get("count") or 50)
    results_wanted = max(1, min(results_wanted, 200))

    sites, sites_err = parse_requested_sites(body, "US")
    if sites_err:
        return jsonify({"error": sites_err}), 400

    date_preset = (body.get("date_preset") or "week").lower()
    if date_preset not in DATE_PRESETS:
        date_preset = "week"
    date_cfg = DATE_PRESETS[date_preset]

    try:
        # easy_apply left unset → LinkedIn returns general listings (not Easy Apply only)
        df = scrape_jobs(
            site_name=sites,
            search_term=search_term,
            location="United States",
            is_remote=True,
            results_wanted=results_wanted,
            country_indeed="usa",
            hours_old=date_cfg["hours_old"],
            wellfound_date_posted=date_cfg["wellfound_date_posted"],
            linkedin_fetch_description=bool(stack),
            easy_apply=None,
            verbose=0,
            request_timeout=120,
        )
    except Exception as e:
        logger.exception("extension scrape_jobs failed")
        return jsonify({"error": str(e)}), 500

    records = _jobs_dataframe_to_records(df)
    if stack:
        records = _filter_jobs_by_stack(records, stack)
    return jsonify(
        {
            "jobs": records,
            "count": len(records),
            "filters": {
                "country": "US",
                "is_remote": True,
                "easy_apply": False,
                "sites": sites,
                "search_term": search_term,
            },
        }
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host="0.0.0.0", port=5000, debug=True)
