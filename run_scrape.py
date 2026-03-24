import csv
from datetime import datetime

from jobspy import scrape_jobs


def main() -> None:
    jobs = scrape_jobs(
        site_name=[
            # "linkedin",
            # "indeed",
            # "glassdoor",
            # "Wellfound",
            # "bdjobs",
            # "google",
            # "naukri",
            # "zip_recruiter",
            # "bayt",
        ],
        search_term="backend engineer",
        google_search_term="backend engineer jobs in United States",
        location="United States",
        is_remote = True,
        results_wanted=50,
        hours_old=24,
        country_indeed="USA",
    )

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"jobs_{timestamp}.csv"
    jobs.to_csv(
        output_file,
        quoting=csv.QUOTE_NONNUMERIC,
        escapechar="\\",
        index=False,
    )

    print(f"Found {len(jobs)} jobs")
    print(f"Saved results to {output_file}")
    print(jobs.head())


if __name__ == "__main__":
    main()
