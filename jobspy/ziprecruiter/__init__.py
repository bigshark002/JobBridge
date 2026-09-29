from __future__ import annotations

import json
import math
import re
import os
import time
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from bs4 import BeautifulSoup
import requests

from jobspy.ziprecruiter.constant import headers, get_cookie_data
from jobspy.util import (
    extract_emails_from_text,
    create_session,
    markdown_converter,
    remove_attributes,
    create_logger,
)
from jobspy.model import (
    JobPost,
    Compensation,
    Location,
    JobResponse,
    Country,
    DescriptionFormat,
    Scraper,
    ScraperInput,
    Site,
)
from jobspy.ziprecruiter.util import get_job_type_enum, add_params

log = create_logger("ZipRecruiter")


class ZipRecruiter(Scraper):
    base_url = "https://www.ziprecruiter.com"
    api_url = "https://api.ziprecruiter.com"

    def __init__(
        self, proxies: list[str] | str | None = None, ca_cert: str | None = None, user_agent: str | None = None
    ):
        """
        Initializes ZipRecruiterScraper with the ZipRecruiter job search url
        """
        super().__init__(Site.ZIP_RECRUITER, proxies=proxies)

        self.scraper_input = None
        self.zenrows_api_key = os.getenv("ZENROWS_API_KEY", "").strip() or None
        self.session = create_session(proxies=proxies, ca_cert=ca_cert)
        self.session.headers.update(headers)
        # Avoid breaking `www.ziprecruiter.com` HTML fetches by pinning Host to the API origin.
        # The `Host` header is derived from the request URL and should not be forced here.
        try:
            self.session.headers.pop("Host", None)
        except Exception:
            pass
        self._get_cookies()

        self.delay = 5
        self.jobs_per_page = 20
        self.seen_urls = set()

    def _fetch_jobs_via_zenrows(
        self, *, params: dict[str, str | int | None]
    ) -> tuple[list[dict], str | None]:
        """
        Fetch ZipRecruiter `jobs-app/jobs` via ZenRows.

        ZenRows usage (from https://www.zenrows.com/blog/bypass-cloudflare):
          - GET https://api.zenrows.com/v1/?url=<target>&apikey=<key>&mode=auto
        """
        if not self.zenrows_api_key:
            return [], None

        target_url = f"{self.api_url}/jobs-app/jobs"
        filtered_params = {k: v for k, v in params.items() if v is not None}
        full_target = f"{target_url}?{urlencode(filtered_params, doseq=True)}"

        zen_params = {
            "url": full_target,
            "apikey": self.zenrows_api_key,
            "mode": "auto",
        }

        # Keep timeout modest to avoid hanging the whole scrape.
        r = requests.get(
            "https://api.zenrows.com/v1/",
            params=zen_params,
            timeout=120,
        )

        if not r.ok:
            log.error(
                f"ZipRecruiter ZenRows request failed: {r.status_code} {r.text[:200]}"
            )
            return [], None

        text = r.text or ""
        try:
            data = r.json()
        except Exception:
            try:
                data = json.loads(text)
            except Exception:
                log.error("ZipRecruiter ZenRows returned non-JSON payload")
                return [], None

        jobs = data.get("jobs", []) or []
        next_continue_token = data.get("continue", None)
        return jobs, next_continue_token

    def scrape(self, scraper_input: ScraperInput) -> JobResponse:
        """
        Scrapes ZipRecruiter for jobs with scraper_input criteria.
        :param scraper_input: Information about job search criteria.
        :return: JobResponse containing a list of jobs.
        """
        self.scraper_input = scraper_input
        job_list: list[JobPost] = []
        continue_token = None
        use_html_fallback = False

        max_pages = math.ceil(scraper_input.results_wanted / self.jobs_per_page)
        for page in range(1, max_pages + 1):
            if len(job_list) >= scraper_input.results_wanted:
                break
            if page > 1:
                time.sleep(self.delay)
            log.info(f"search page: {page} / {max_pages}")
            if use_html_fallback:
                jobs_on_page = self._find_jobs_in_page_html(scraper_input, page=page)
                continue_token = None
            else:
                jobs_on_page, continue_token = self._find_jobs_in_page(
                    scraper_input, continue_token
                )
                # ZipRecruiter mobile API often returns HTTP 200 + empty jobs (WAF / anti-bot).
                # If the first page is empty, fall back to parsing the public HTML search results.
                if page == 1 and not jobs_on_page:
                    log.warning(
                        "ZipRecruiter API returned no jobs; falling back to HTML results parsing."
                    )
                    use_html_fallback = True
                    jobs_on_page = self._find_jobs_in_page_html(scraper_input, page=page)
                    continue_token = None
            if jobs_on_page:
                job_list.extend(jobs_on_page)
            else:
                break
            if not continue_token:
                break
        return JobResponse(jobs=job_list[: scraper_input.results_wanted])

    def _find_jobs_in_page(
        self, scraper_input: ScraperInput, continue_token: str | None = None
    ) -> tuple[list[JobPost], str | None]:
        """
        Scrapes a page of ZipRecruiter for jobs with scraper_input criteria
        :param scraper_input:
        :param continue_token:
        :return: jobs found on page
        """
        jobs_list = []
        params = add_params(scraper_input)
        if continue_token:
            params["continue_from"] = continue_token
        try:
            res = self.session.get(f"{self.api_url}/jobs-app/jobs", params=params)
            if res.status_code not in range(200, 400):
                if res.status_code == 429:
                    err = "429 Response - Blocked by ZipRecruiter for too many requests"
                else:
                    err = f"ZipRecruiter response status code {res.status_code}"
                    err += f" with response: {res.text}"  # ZipRecruiter likely not available in EU
                log.error(err)
                # Try ZenRows bypass for blocked/forbidden responses.
                if self.zenrows_api_key:
                    zen_jobs, zen_next_token = self._fetch_jobs_via_zenrows(params=params)
                    if zen_jobs:
                        # Continue below with normal processing
                        jobs_list = zen_jobs
                        next_continue_token = zen_next_token
                        return jobs_list, next_continue_token
                return jobs_list, ""
        except Exception as e:
            if "Proxy responded with" in str(e):
                log.error("ZipRecruiter: Bad proxy")
            else:
                log.error(f"ZipRecruiter: {str(e)}")
            return jobs_list, ""

        res_data = res.json()
        jobs_list = res_data.get("jobs", [])
        next_continue_token = res_data.get("continue", None)

        # Some environments return HTTP 200 with empty `jobs` due to WAF/anti-bot.
        # If jobs are empty, try ZenRows as a recovery path.
        if (not jobs_list) and self.zenrows_api_key:
            zen_jobs, zen_next_token = self._fetch_jobs_via_zenrows(params=params)
            if zen_jobs:
                jobs_list = zen_jobs
                next_continue_token = zen_next_token
        with ThreadPoolExecutor(max_workers=self.jobs_per_page) as executor:
            job_results = [executor.submit(self._process_job, job) for job in jobs_list]

        job_list = list(filter(None, (result.result() for result in job_results)))
        return job_list, next_continue_token

    def _find_jobs_in_page_html(self, scraper_input: ScraperInput, *, page: int) -> list[JobPost]:
        """
        Fallback parser for ZipRecruiter public HTML search results.
        This avoids the `jobs-app/jobs` API returning empty results under WAF rules.
        """
        params = add_params(scraper_input)
        params["page"] = page

        try:
            res = self.session.get(
                f"{self.base_url}/jobs-search",
                params=params,
                allow_redirects=True,
            )
        except Exception as e:
            log.error(f"ZipRecruiter HTML fetch failed: {str(e)}")
            return []

        if res.status_code not in range(200, 400):
            log.error(
                f"ZipRecruiter HTML response status code {res.status_code} with response: {res.text[:300]}"
            )
            return []

        # Cloudflare challenge pages are HTML with "Just a moment..." content.
        if res.status_code == 200 and res.text and "Just a moment" in res.text[:4000]:
            log.error("ZipRecruiter HTML returned a Cloudflare challenge page.")
            return []

        soup = BeautifulSoup(res.text, "html.parser")
        articles = soup.find_all("article", id=re.compile(r"^job-card-"))
        if not articles:
            return []

        jobs: list[JobPost] = []
        for art in articles:
            try:
                card_id = art.get("id") or ""
                listing_key = card_id.split("job-card-", 1)[1] if "job-card-" in card_id else ""
                if not listing_key:
                    continue

                job_url = f"{self.base_url}/jobs//j?lvk={listing_key}"
                if job_url in self.seen_urls:
                    continue
                self.seen_urls.add(job_url)

                title = None
                h = art.find(["h1", "h2", "h3"])
                if h:
                    title = h.get_text(" ", strip=True) or None
                if not title:
                    img = art.find("img", alt=True)
                    title = (img.get("alt") or "").strip() or None

                co_el = art.select_one('[data-testid="job-card-company"]')
                company = co_el.get_text(" ", strip=True) if co_el else None
                loc_el = art.select_one('[data-testid="job-card-location"]')
                loc_text = loc_el.get_text(" ", strip=True) if loc_el else None

                # Parse location to match existing UI expectations.
                # When ZipRecruiter only gives "City, ST" we treat it as USA/Canada based on country.
                city = state = None
                if loc_text and "," in loc_text:
                    city, state = [p.strip() for p in loc_text.split(",", 1)]

                country_value = (
                    "usa"
                    if scraper_input.country in (Country.USA, Country.WORLDWIDE)
                    else "canada"
                )
                country_enum = Country.from_string(country_value)

                location = Location(city=city, state=state, country=country_enum)

                description_full, job_url_direct = self._get_descr(job_url)

                jobs.append(
                    JobPost(
                        id=f"zr-{listing_key}",
                        title=title,
                        company_name=company,
                        location=location,
                        job_type=None,
                        compensation=None,
                        date_posted=None,
                        job_url=job_url,
                        description=description_full,
                        emails=extract_emails_from_text(description_full) if description_full else None,
                        job_url_direct=job_url_direct,
                        listing_type=None,
                    )
                )
            except Exception:
                continue

        return jobs

    def _process_job(self, job: dict) -> JobPost | None:
        """
        Processes an individual job dict from the response
        """
        title = job.get("name")
        job_url = f"{self.base_url}/jobs//j?lvk={job['listing_key']}"
        if job_url in self.seen_urls:
            return
        self.seen_urls.add(job_url)

        description = job.get("job_description", "").strip()
        listing_type = job.get("buyer_type", "")
        description = (
            markdown_converter(description)
            if self.scraper_input.description_format == DescriptionFormat.MARKDOWN
            else description
        )
        company = job.get("hiring_company", {}).get("name")
        country_value = "usa" if job.get("job_country") == "US" else "canada"
        country_enum = Country.from_string(country_value)

        location = Location(
            city=job.get("job_city"), state=job.get("job_state"), country=country_enum
        )
        job_type = get_job_type_enum(
            job.get("employment_type", "").replace("_", "").lower()
        )
        date_posted = datetime.fromisoformat(job["posted_time"].rstrip("Z")).date()
        comp_interval = job.get("compensation_interval")
        comp_interval = "yearly" if comp_interval == "annual" else comp_interval
        comp_min = int(job["compensation_min"]) if "compensation_min" in job else None
        comp_max = int(job["compensation_max"]) if "compensation_max" in job else None
        comp_currency = job.get("compensation_currency")
        description_full, job_url_direct = self._get_descr(job_url)

        return JobPost(
            id=f'zr-{job["listing_key"]}',
            title=title,
            company_name=company,
            location=location,
            job_type=job_type,
            compensation=Compensation(
                interval=comp_interval,
                min_amount=comp_min,
                max_amount=comp_max,
                currency=comp_currency,
            ),
            date_posted=date_posted,
            job_url=job_url,
            description=description_full if description_full else description,
            emails=extract_emails_from_text(description) if description else None,
            job_url_direct=job_url_direct,
            listing_type=listing_type,
        )

    def _get_descr(self, job_url):
        res = self.session.get(job_url, allow_redirects=True)
        description_full = job_url_direct = None
        if res.ok:
            soup = BeautifulSoup(res.text, "html.parser")
            job_descr_div = soup.find("div", class_="job_description")
            company_descr_section = soup.find("section", class_="company_description")
            job_description_clean = (
                remove_attributes(job_descr_div).prettify(formatter="html")
                if job_descr_div
                else ""
            )
            company_description_clean = (
                remove_attributes(company_descr_section).prettify(formatter="html")
                if company_descr_section
                else ""
            )
            description_full = job_description_clean + company_description_clean

            try:
                script_tag = soup.find("script", type="application/json")
                if script_tag:
                    job_json = json.loads(script_tag.string)
                    job_url_val = job_json["model"].get("saveJobURL", "")
                    m = re.search(r"job_url=(.+)", job_url_val)
                    if m:
                        job_url_direct = m.group(1)
            except:
                job_url_direct = None

            if self.scraper_input.description_format == DescriptionFormat.MARKDOWN:
                description_full = markdown_converter(description_full)

        return description_full, job_url_direct

    def _get_cookies(self):
        """
        Sends a session event to the API with device properties.
        """
        url = f"{self.api_url}/jobs-app/event"
        self.session.post(url, data=get_cookie_data)
