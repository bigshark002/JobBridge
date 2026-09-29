# JobBridge Chrome Extension

Standalone extension — **no `web.app` / Flask server required**.

Fetches **remote-only US** jobs by calling the same public APIs / HTML endpoints JobSpy uses, then downloads an Excel (`.xlsx`) file.

## Platforms

| Option | How it fetches |
|--------|----------------|
| LinkedIn | Guest search cards — remote (`f_WT=2`) + US only (no Easy Apply search / no detail pages) |
| Indeed | GraphQL `apis.indeed.com` — remote attribute `DSQF7` |
| Wellfound | `POST api.orgupdate.com/search-jobs-v1` |
| Glassdoor | GraphQL via a real `glassdoor.com` tab (Cloudflare bypass) |
| ZipRecruiter | Tab scrape of `ziprecruiter.com` jobs-search HTML |
| Jobright | Tab scrape of `jobright.ai` — `/jobs/search` + public `/remote-jobs` SSR; optional logged-in swan-api pagination |
| Dice | Tab scrape of `dice.com/jobs` — Next.js RSC `jobList` (remote + posted date filters) |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Pin **JobBridge Fetch** → set platforms / count / title / stack → **OK**
5. Keep the fetch tab open until the Excel download finishes

If you already had the extension loaded, click **Reload** on the card after updates.

## Popup fields

- **Platforms** — multi-select
- **Count** — max results **per platform** (1–200)
- **Posted** — **Today** (last 24h) or **3 days** (last 72h); applied on each board’s date filter
- **Title** / **Stack** — search keywords (stack also filters title/description)
- **OK** — opens a runner tab that scrapes in-browser and saves `.xlsx`

## Notes

- Boards may rate-limit or change HTML/APIs; failed platforms are listed in the runner log while others still export.
- **403 fixes:** the extension installs `declarativeNetRequest` header rules so Indeed gets the mobile Indeed App User-Agent, and Glassdoor/Wellfound get a normal browser Origin (not `chrome-extension://`). After updating, click **Reload** on the extension card (needed once so the background worker installs rules).
- **Glassdoor / ZipRecruiter / Jobright / Dice Cloudflare:** scrape runs inside a real site tab. If a security page appears, complete it there and press OK again.
- **Jobright tip:** logging into jobright.ai in that tab enables extra results via their API; otherwise public remote listings still work.
- Title tokens must appear in the **job title** on every platform. Stack tokens may match title or description.
- Excel is built with SheetJS (`lib/xlsx.mini.min.js`).
