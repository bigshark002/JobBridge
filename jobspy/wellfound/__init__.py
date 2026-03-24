from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import requests

from jobspy.model import (
    Country,
    JobPost,
    JobResponse,
    JobType,
    Location,
    Scraper,
    ScraperInput,
    Site,
)
from jobspy.util import create_logger, create_session, get_enum_from_job_type
from jobspy.wellfound.constant import (
    DEFAULT_API_URL,
    DEFAULT_HEADERS,
    ESTIMATED_JOBS_PER_PAGE,
)

log = create_logger("Wellfound")


def _country_slug(country: Country | None) -> str:
    """Map JobSpy Country to Wellfound `countryName` (Apify README: usa, uk, india, …)."""
    if country is None or country == Country.WORLDWIDE:
        return "all"
    if country == Country.UK:
        return "uk"
    if country == Country.USA:
        return "usa"
    # Enum name: NEWZEALAND -> newzealand; API may accept variations
    return country.name.lower().replace("_", "")


def _hours_to_date_posted(hours: int | None) -> str:
    """Map `hours_old` to Apify `datePosted` enum."""
    if hours is None:
        return "month"
    if hours <= 24:
        return "today"
    if hours <= 72:
        return "3days"
    if hours <= 168:
        return "week"
    return "month"


def _job_type_to_api(jt: JobType | None) -> str | None:
    if jt is None:
        return None
    mapping = {
        JobType.FULL_TIME: "FULLTIME",
        JobType.PART_TIME: "PARTTIME",
        JobType.CONTRACT: "CONTRACTOR",
        JobType.INTERNSHIP: "INTERN",
    }
    return mapping.get(jt)


def _normalize_job_type_str(s: str | None) -> list[JobType] | None:
    if not s:
        return None
    norm = re.sub(r"[\s_-]+", "", s.lower())
    for alias in (
        norm,
        s.lower().strip(),
        s.lower().replace("-", "").replace(" ", ""),
    ):
        found = get_enum_from_job_type(alias) if alias else None
        if found:
            return [found]
    return None


def _parse_posted_date(raw: str | None) -> date | None:
    if not raw:
        return None
    s = raw.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _pick(d: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default


# Prefer direct / ATS links over fields that point at Google Jobs SERP or redirectors.
_URL_KEYS_PRIORITY = (
    "applyUrl",
    "apply_url",
    "applicationUrl",
    "application_url",
    "jobUrlDirect",
    "job_url_direct",
    "directUrl",
    "direct_url",
    "jobUrl",
    "job_url",
    "URL",
    "url",
    "link",
)


def _unwrap_google_redirect(url: str) -> str:
    """Resolve google.com/url?q=… wrappers to the embedded target URL."""
    try:
        p = urlparse(url.strip())
        if "google." in p.netloc.lower() and p.path.rstrip("/").endswith("/url"):
            qs = parse_qs(p.query)
            q = (qs.get("q") or [None])[0]
            if q:
                return unquote(q).strip()
    except Exception:
        pass
    return url.strip()


def _url_quality_score(url: str) -> int:
    """Higher = better primary job link (avoid bare Google search / SERP URLs)."""
    u = _unwrap_google_redirect(url)
    if not u.startswith("http"):
        return -1
    p = urlparse(u)
    host = p.netloc.lower()
    path = p.path.lower()

    if "google." in host and "/search" in path:
        return 0
    if any(
        x in host
        for x in ("wellfound.com", "angel.co", "angellist.com", "startup.jobs")
    ):
        return 100
    if any(
        x in host
        for x in (
            "greenhouse.io",
            "lever.co",
            "workable.com",
            "ashbyhq.com",
            "myworkdayjobs.com",
            "smartrecruiters.com",
            "taleo.net",
            "icims.com",
        )
    ):
        return 85
    if "google." in host:
        return 20
    return 60


def _best_job_url(row: dict[str, Any]) -> str:
    candidates: list[str] = []
    for k in _URL_KEYS_PRIORITY:
        v = row.get(k)
        if isinstance(v, str) and v.strip().startswith("http"):
            candidates.append(v.strip())
    if not candidates:
        return ""
    best, best_score = "", -1
    for c in candidates:
        unwrapped = _unwrap_google_redirect(c)
        score = _url_quality_score(unwrapped)
        if score > best_score:
            best_score = score
            best = unwrapped
    return best


def _extract_rows(payload: Any) -> list[dict[str, Any]]:
    """Normalize API body to a list of job dicts (handles several shapes)."""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("jobs", "data", "results", "items", "list"):
            v = payload.get(key)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
        if any(
            _pick(payload, k) is not None
            for k in ("jobUrl", "job_url", "URL", "jobTitle", "job_title")
        ):
            return [payload]
    return []


class Wellfound(Scraper):
    """
    Wellfound job listings via the same backend as Apify-Wellfound-Jobs-Scraper:
    POST https://api.orgupdate.com/search-jobs-v1 with ``source: wellfound``.
    """

    def __init__(
        self,
        proxies: list[str] | str | None = None,
        ca_cert: str | None = None,
        user_agent: str | None = None,
    ):
        super().__init__(Site.WELLFOUND, proxies=proxies, ca_cert=ca_cert, user_agent=user_agent)
        self.session = create_session(
            proxies=self.proxies,
            ca_cert=self.ca_cert,
            is_tls=False,
            has_retry=True,
            delay=2,
        )
        hdrs = dict(DEFAULT_HEADERS)
        if self.user_agent:
            hdrs["User-Agent"] = self.user_agent
        self.session.headers.update(hdrs)

    def scrape(self, scraper_input: ScraperInput) -> JobResponse:
        api_url = scraper_input.wellfound_api_url or DEFAULT_API_URL
        country = (
            scraper_input.wellfound_country_name
            or _country_slug(scraper_input.country)
        )
        date_posted = (
            scraper_input.wellfound_date_posted
            or _hours_to_date_posted(scraper_input.hours_old)
        )
        pages = scraper_input.wellfound_pages_to_fetch
        if pages is None:
            pages = max(
                1,
                (scraper_input.results_wanted + ESTIMATED_JOBS_PER_PAGE - 1)
                // ESTIMATED_JOBS_PER_PAGE,
            )

        keyword = (scraper_input.search_term or "").strip()
        if scraper_input.is_remote and keyword:
            keyword = f"{keyword} remote"
        elif scraper_input.is_remote:
            keyword = "remote"

        body: dict[str, Any] = {
            "source": "wellfound",
            "countryName": country,
            "includeKeyword": keyword or "software engineer",
            "locationName": (scraper_input.location or "").strip(),
            "pagesToFetch": int(pages),
            "datePosted": date_posted,
        }
        if scraper_input.wellfound_company_name:
            body["companyName"] = scraper_input.wellfound_company_name.strip()

        api_jt = _job_type_to_api(scraper_input.job_type)
        if api_jt:
            body["jobType"] = api_jt

        log.info(
            f"POST {api_url} (pages={pages}, country={country}, datePosted={date_posted})"
        )

        try:
            r = self.session.post(
                api_url,
                json=body,
                timeout=scraper_input.request_timeout,
            )
        except requests.RequestException as e:
            log.error(f"Wellfound: request failed: {e}")
            return JobResponse(jobs=[])

        if r.status_code not in range(200, 300):
            log.error(
                f"Wellfound: HTTP {r.status_code} — {r.text[:500] if r.text else ''}"
            )
            return JobResponse(jobs=[])

        try:
            payload = r.json()
        except json.JSONDecodeError as e:
            log.error(f"Wellfound: invalid JSON: {e}")
            return JobResponse(jobs=[])

        rows = _extract_rows(payload)
        jobs: list[JobPost] = []
        seen: set[str] = set()

        for row in rows:
            title = _pick(row, "job_title", "jobTitle", "title", default="") or ""
            url = _best_job_url(row)
            if not url or url in seen:
                continue
            seen.add(url)

            company = _pick(row, "company_name", "companyName", "company", default="")
            loc_str = _pick(row, "location", "jobLocation", default="") or ""
            description = _pick(row, "description", "jobDescription", default=None)
            posted_raw = _pick(row, "date", "postedDate", "posted_date", default=None)
            salary_str = _pick(row, "salary", "compensation", default=None)
            posted_via = _pick(row, "posted_via", "postedVia", "source", default=None)
            jt_str = _pick(row, "job_type", "jobType", default=None)

            if description and posted_via:
                description = f"*{posted_via}*\n\n{description}"

            loc = Location(city=loc_str.strip() or None, country=Country.WORLDWIDE)
            date_posted = _parse_posted_date(str(posted_raw) if posted_raw else None)

            job_types = _normalize_job_type_str(str(jt_str) if jt_str else None)
            is_remote = bool(
                re.search(r"\bremote\b", f"{title} {loc_str}".lower(), re.I)
            )

            job = JobPost(
                id=f"wf-{abs(hash(url)) % (10**12)}",
                title=title.strip() or "Untitled",
                company_name=str(company).strip() if company else "Unknown",
                job_url=str(url).strip(),
                location=loc,
                description=str(description).strip() if description else None,
                date_posted=date_posted,
                job_type=job_types,
                is_remote=is_remote,
                listing_type=str(posted_via).lower() if posted_via else None,
            )
            if salary_str:
                job.description = (
                    (job.description or "")
                    + f"\n\n**Salary:** {salary_str}"
                ).strip()

            jobs.append(job)

        jobs = jobs[: scraper_input.results_wanted]
        log.info(f"Wellfound: parsed {len(jobs)} jobs")
        return JobResponse(jobs=jobs)
