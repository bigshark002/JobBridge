"""Wellfound (AngelList) job search via orgupdate API — same contract as Apify-Wellfound-Jobs-Scraper."""

# Matches `Apify-Wellfound-Jobs-Scraper/main.js`
DEFAULT_API_URL = "https://api.orgupdate.com/search-jobs-v1"

DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
}

# Rough jobs per page for mapping results_wanted -> pagesToFetch when not overridden
ESTIMATED_JOBS_PER_PAGE = 20
