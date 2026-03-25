<img src="https://github.com/cullenwatson/JobSpy/assets/78247585/ae185b7e-e444-4712-8bb9-fa97f53e896b" width="400">

**JobBridge** is the branded web app shipped in this repository (`web/`): a Flask UI to search multiple boards, tune platforms and filters, and browse results with pagination.

It is powered by **JobSpy**, a Python job scraping library that aggregates listings from popular job boards with one tool. The installable package name remains `python-jobspy` and imports use `jobspy`.

## Features

- Scrapes job postings from **LinkedIn**, **Indeed**, **Glassdoor**, **Google**, **ZipRecruiter**, **Wellfound**, & other job boards concurrently
- Aggregates the job postings in a dataframe
- Proxies support to bypass blocking

![jobspy](https://github.com/cullenwatson/JobSpy/assets/78247585/ec7ef355-05f6-4fd3-8161-a817e31c5c57)

### Installation

```
pip install -U python-jobspy
```

_Python version >= [3.10](https://www.python.org/downloads/release/python-3100/) required_

### Web UI (JobBridge)

**JobBridge** is the front-end for the Flask app under `web/`. It searches **LinkedIn**, **Indeed**, **Wellfound**, and **Glassdoor** (you can enable or disable each platform before running a search), shows results in a table with **client-side pagination** (15 rows per page, up to 100 jobs per request), and loads countries from the public [REST Countries](https://restcountries.com/) API. Title links prefer `job_url_direct` when present, otherwise `job_url`.

```bash
pip install flask
# from the repository root:
python -m web.app
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). Searches can take several minutes when many sources are selected, because they run in one request.

**Note:** **Anywhere (no country)** or **Worldwide** runs a global-style search (no country location), skips Glassdoor, and uses the same rules as worldwide in JobSpy. **Remote only** maps to the library’s remote filters; on Indeed, date filters take priority over remote when both are set (see limitations below). Defaults in the UI include **posted: Today**, **remote on**, and all four platforms selected where applicable.

### Docker (JobBridge)

Run the web UI in a container (no local Python setup required). The image installs dependencies with **Poetry**, serves the app with **Gunicorn** (900s worker timeout for long scrapes), and listens on **`PORT`** (default **5000**).

**Compose (recommended):**

```bash
docker compose up --build
```

Open [http://127.0.0.1:5000](http://127.0.0.1:5000). To use another host port:

```bash
JOBBRIDGE_PORT=8080 docker compose up --build
```

**Docker only:**

```bash
docker build -t jobbridge .
docker run --rm -p 5000:5000 jobbridge
```

Custom port inside the container (e.g. some PaaS set `PORT`):

```bash
docker run --rm -e PORT=8080 -p 8080:8080 jobbridge
```

**Requirements:** [Docker Engine](https://docs.docker.com/engine/install/) with BuildKit and [Compose V2](https://docs.docker.com/compose/install/) (`docker compose`).

If `docker build` fails while compiling a dependency, add build tools to the image (e.g. install `build-essential` in the `Dockerfile` `apt-get` step) and rebuild.

### Usage

```python
import csv
from jobspy import scrape_jobs

jobs = scrape_jobs(
    site_name=["indeed", "linkedin", "zip_recruiter", "google"], # "glassdoor", "bayt", "naukri", "bdjobs", "wellfound"
    search_term="software engineer",
    google_search_term="software engineer jobs near San Francisco, CA since yesterday",
    location="San Francisco, CA",
    results_wanted=20,
    hours_old=72,
    country_indeed='USA',
    
    # linkedin_fetch_description=True # gets more info such as description, direct job url (slower)
    # proxies=["208.195.175.46:65095", "208.195.175.45:65095", "localhost"],
)
print(f"Found {len(jobs)} jobs")
print(jobs.head())
jobs.to_csv("jobs.csv", quoting=csv.QUOTE_NONNUMERIC, escapechar="\\", index=False) # to_excel
```

### Output

```
SITE           TITLE                             COMPANY           CITY          STATE  JOB_TYPE  INTERVAL  MIN_AMOUNT  MAX_AMOUNT  JOB_URL                                            DESCRIPTION
indeed         Software Engineer                 AMERICAN SYSTEMS  Arlington     VA     None      yearly    200000      150000      https://www.indeed.com/viewjob?jk=5e409e577046...  THIS POSITION COMES WITH A 10K SIGNING BONUS!...
indeed         Senior Software Engineer          TherapyNotes.com  Philadelphia  PA     fulltime  yearly    135000      110000      https://www.indeed.com/viewjob?jk=da39574a40cb...  About Us TherapyNotes is the national leader i...
linkedin       Software Engineer - Early Career  Lockheed Martin   Sunnyvale     CA     fulltime  yearly    None        None        https://www.linkedin.com/jobs/view/3693012711      Description:By bringing together people that u...
linkedin       Full-Stack Software Engineer      Rain              New York      NY     fulltime  yearly    None        None        https://www.linkedin.com/jobs/view/3696158877      Rain’s mission is to create the fastest and ea...
zip_recruiter Software Engineer - New Grad       ZipRecruiter      Santa Monica  CA     fulltime  yearly    130000      150000      https://www.ziprecruiter.com/jobs/ziprecruiter...  We offer a hybrid work environment. Most US-ba...
zip_recruiter Software Developer                 TEKsystems        Phoenix       AZ     fulltime  hourly    65          75          https://www.ziprecruiter.com/jobs/teksystems-0...  Top Skills' Details• 6 years of Java developme...

```

### Parameters for `scrape_jobs()`

```plaintext
Optional
├── site_name (list|str): 
|    linkedin, zip_recruiter, indeed, glassdoor, google, bayt, bdjobs, wellfound
|    (default is all)
│
├── search_term (str)
|
├── google_search_term (str)
|     search term for google jobs. This is the only param for filtering google jobs.
│
├── location (str)
│
├── distance (int): 
|    in miles, default 50
│
├── job_type (str): 
|    fulltime, parttime, internship, contract
│
├── proxies (list): 
|    in format ['user:pass@host:port', 'localhost']
|    each job board scraper will round robin through the proxies
|
├── is_remote (bool)
│
├── results_wanted (int): 
|    number of job results to retrieve for each site specified in 'site_name'
│
├── easy_apply (bool): 
|    filters for jobs that are hosted on the job board site (LinkedIn easy apply filter no longer works)
|
├── user_agent (str): 
|    override the default user agent which may be outdated
│
├── request_timeout (int):
|    seconds for HTTP read timeout on scrapers that honor it (e.g. Indeed’s GraphQL API). Default 60.
│
├── description_format (str): 
|    markdown, html (Format type of the job descriptions. Default is markdown.)
│
├── offset (int): 
|    starts the search from an offset (e.g. 25 will start the search from the 25th result)
│
├── hours_old (int): 
|    filters jobs by the number of hours since the job was posted 
|    (ZipRecruiter and Glassdoor round up to next day.)
│
├── verbose (int) {0, 1, 2}: 
|    Controls the verbosity of the runtime printouts 
|    (0 prints only errors, 1 is errors+warnings, 2 is all logs. Default is 2.)

├── linkedin_fetch_description (bool): 
|    fetches full description and direct job url for LinkedIn (Increases requests by O(n))
│
├── linkedin_company_ids (list[int]): 
|    searches for linkedin jobs with specific company ids
|
├── country_indeed (str): 
|    filters the country on Indeed & Glassdoor (see below for correct spelling)
|
├── enforce_annual_salary (bool): 
|    converts wages to annual salary
|
├── ca_cert (str)
|    path to CA Certificate file for proxies
│
├── wellfound_company_name (str): optional employer filter (Wellfound / orgupdate API only)
│
├── wellfound_pages_to_fetch (int): pagination depth for Wellfound (default derived from results_wanted)
│
├── wellfound_date_posted (str): `all`, `today`, `3days`, `week`, `month` (overrides hours_old mapping)
│
├── wellfound_country_name (str): e.g. `usa`, `uk`, `india` (overrides country_indeed → API mapping)
│
├── wellfound_api_url (str): override default `https://api.orgupdate.com/search-jobs-v1`
```

### Wellfound (`site_name="wellfound"`)

Wellfound uses the same backend as the bundled **Apify-Wellfound-Jobs-Scraper** actor: a JSON `POST` to `https://api.orgupdate.com/search-jobs-v1` with `source: "wellfound"` and the parameters described in `Apify-Wellfound-Jobs-Scraper/README.md`.

- **`search_term`** → `includeKeyword` (if `is_remote`, `remote` is appended to the keyword).
- **`location`** → `locationName`
- **`country_indeed`** → `countryName` (e.g. USA → `usa`, UK → `uk`; use `wellfound_country_name` to set it explicitly, or `all` for worldwide).
- **`hours_old`** → `datePosted` (`today` / `3days` / `week` / `month`) unless **`wellfound_date_posted`** is set.
- **`job_type`** → `jobType` (`FULLTIME`, `PARTTIME`, `CONTRACTOR`, `INTERN`) when mappable.

Requires outbound HTTPS access to the API host. If the API is slow or unavailable, Wellfound returns zero rows for that site and logs an error; other sites in the same `scrape_jobs()` call still run.

**Why do some `job_url` values look like Google links?** The orgupdate aggregator often stores a Google Jobs / SERP URL or a `google.com/url?q=…` redirect as the main link. JobSpy unwraps `google.com/url?q=…` when possible and prefers fields like `applyUrl` / direct URLs over plain `URL` when the payload includes them. If every field is still a Google search page, that is what the API returned—not a direct Wellfound or ATS apply link.

```python
jobs = scrape_jobs(
    site_name="wellfound",
    search_term="python backend",
    location="San Francisco, CA",
    country_indeed="USA",
    results_wanted=20,
    wellfound_date_posted="week",
    # wellfound_company_name="Acme",
    # wellfound_pages_to_fetch=2,
)
```

```plaintext
├── Indeed limitations:
|    Only one from this list can be used in a search:
|    - hours_old
|    - job_type & is_remote
|    - easy_apply
│
└── LinkedIn limitations:
|    Only one from this list can be used in a search:
|    - hours_old
|    - easy_apply
```

## Supported Countries for Job Searching

### **LinkedIn**

LinkedIn searches globally & uses only the `location` parameter. 

### **ZipRecruiter**

ZipRecruiter searches for jobs in **US/Canada** & uses only the `location` parameter.

### **Indeed / Glassdoor**

Indeed & Glassdoor supports most countries, but the `country_indeed` parameter is required. Additionally, use the `location`
parameter to narrow down the location, e.g. city & state if necessary. 

You can specify the following countries when searching on Indeed (use the exact name, * indicates support for Glassdoor):

|                      |              |            |                |
|----------------------|--------------|------------|----------------|
| Argentina            | Australia*   | Austria*   | Bahrain        |
| Belgium*             | Brazil*      | Canada*    | Chile          |
| China                | Colombia     | Costa Rica | Czech Republic |
| Denmark              | Ecuador      | Egypt      | Finland        |
| France*              | Germany*     | Greece     | Hong Kong*     |
| Hungary              | India*       | Indonesia  | Ireland*       |
| Israel               | Italy*       | Japan      | Kuwait         |
| Luxembourg           | Malaysia     | Mexico*    | Morocco        |
| Netherlands*         | New Zealand* | Nigeria    | Norway         |
| Oman                 | Pakistan     | Panama     | Peru           |
| Philippines          | Poland       | Portugal   | Qatar          |
| Romania              | Saudi Arabia | Singapore* | South Africa   |
| South Korea          | Spain*       | Sweden     | Switzerland*   |
| Taiwan               | Thailand     | Turkey     | Ukraine        |
| United Arab Emirates | UK*          | USA*       | Uruguay        |
| Venezuela            | Vietnam*     |            |                |

### **Bayt**

Bayt only uses the search_term parameter currently and searches internationally



## Notes
* **Indeed read timeouts:** If you see `Read timed out` from `apis.indeed.com`, the board may be slow, your network or VPN may add latency, or a datacenter IP may be throttled. The library uses `request_timeout` (default **60**s; JobBridge’s web API uses **120**s). Increase `request_timeout` in `scrape_jobs()` if needed, or retry later / try a residential proxy.
* Indeed is often reliable but can still rate-limit or block aggressive traffic.  
* All the job board endpoints are capped at around 1000 jobs on a given search.  
* LinkedIn is the most restrictive and usually rate limits around the 10th page with one ip. Proxies are a must basically.

## Frequently Asked Questions

---
**Q: Why is Indeed giving unrelated roles?**  
**A:** Indeed searches the description too.

- use - to remove words
- "" for exact match

Example of a good Indeed query

```py
search_term='"engineering intern" software summer (java OR python OR c++) 2025 -tax -marketing'
```

This searches the description/title and must include software, summer, 2025, one of the languages, engineering intern exactly, no tax, no marketing.

---

**Q: No results when using "google"?**  
**A:** You have to use super specific syntax. Search for google jobs on your browser and then whatever pops up in the google jobs search box after applying some filters is what you need to copy & paste into the google_search_term. 

---

**Q: Received a response code 429?**  
**A:** This indicates that you have been blocked by the job board site for sending too many requests. All of the job board sites are aggressive with blocking. We recommend:

- Wait some time between scrapes (site-dependent).
- Try using the proxies param to change your IP address.

---

### JobPost Schema

```plaintext
JobPost
├── title
├── company
├── company_url
├── job_url
├── location
│   ├── country
│   ├── city
│   ├── state
├── is_remote
├── description
├── job_type: fulltime, parttime, internship, contract
├── job_function
│   ├── interval: yearly, monthly, weekly, daily, hourly
│   ├── min_amount
│   ├── max_amount
│   ├── currency
│   └── salary_source: direct_data, description (parsed from posting)
├── date_posted
└── emails

Linkedin specific
└── job_level

Linkedin & Indeed specific
└── company_industry

Indeed specific
├── company_country
├── company_addresses
├── company_employees_label
├── company_revenue_label
├── company_description
└── company_logo

Naukri specific
├── skills
├── experience_range
├── company_rating
├── company_reviews_count
├── vacancy_count
└── work_from_home_type
```
