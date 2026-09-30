# JobBridge EU Chrome Extension

Standalone extension for **fully remote jobs that can be worked from the EU or the UK**. It does not use the Flask app.

## Platforms

| Option | How it fetches |
|--------|----------------|
| Djinni | `djinni.co/jobs/?all_keywords=…&search_type=basic-search`. Title must contain the search term (so “AI/ML Engineer” matches “ai engineer”). Keeps Full Remote and Hybrid Remote in Ukraine, Europe, UK, or worldwide. |
| Workable | `jobs.workable.com/search?query=…&workplace=remote&day_range=1` (2 or 3 for the other posted windows), then keep EU and UK jobs whose title contains the search term |
| RemoteYeah | Europe and UK listing pages (`remoteyeah.com`), posted time on each card |
| SimplyHired | Country sites (`simplyhired.co.uk`, `.de`, `.fr`, `.nl`, `.es`, `.it`, `.ie`, and others) with `l=remote`. A header rule swaps the User-Agent so Cloudflare does not return 403 |
| Remote Rocketship | Newest jobs embedded on the Europe and UK pages. An optional subscriber API key pages `POST /api/openclaw/jobs/` |
| NoDesk | Public job index behind [nodesk.substack.com](https://nodesk.substack.com/), searched at `nodesk.co/remote-jobs` |
| G2i | Ashby board `jobs.ashbyhq.com/g2i` |
| LinkedIn | Guest search, remote, European Union then the UK. 429/999 wait and retry; jobs already found are kept. A header rule strips the extension Origin so LinkedIn treats the request as a normal browser search |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension-eu/` folder
4. Set platforms, posted window (1, 2, or 3 days), optional title and stack → **OK**

Reload the extension card after updates.

## Popup fields

- **Platforms** — multi-select
- **Count** — max results per platform (1–200)
- **Posted** — 1, 2, or 3 days
- **Title** / **Stack** — optional. Title words must appear in the job title. Stack words may match the title or description.
- **Rocketship key** — optional. From the Remote Rocketship account (API access). Without it, only the newest Europe and UK page is included.

Jobs with the same title and company are kept once. Excel is built with SheetJS (`lib/xlsx.mini.min.js`).
