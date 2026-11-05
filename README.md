# anime-app-data

Data for the anime app, rebuilt every night by GitHub Actions.
The app downloads these files at most once a day; nothing here is secret.

| File | What it is |
|---|---|
| `data/top_anime.json` | Best-rated anime overall and per genre, seasons grouped, season count, status, legal services |
| `data/synopsis_ar.json` | Arabic stories by AniList id; new airing anime are added each night |
| `data/news.json` | News for the News tab, rebuilt every hour (see "News" below) |
| `data/manifest.json` | A fingerprint per file, so the app only downloads what changed |

The job: `scripts/build.mjs` (Node 22, no dependencies), scheduled in
`.github/workflows/update-data.yml` at 02:17 UTC.

## One-time setup

### 1. Create the repository
1. On github.com: **+** (top right) → **New repository**.
2. Name: `anime-app-data`. Visibility: **Public** (the app downloads the files without a login; the app's code stays in your private repo).
3. Don't add a README (this folder already has one) → **Create repository**.

### 2. Upload this folder
In a terminal (the first two lines move the schedule file into the folder GitHub reads it from):
```powershell
cd D:\claude\coding\anime-app\data-pipeline
New-Item -ItemType Directory -Force .github\workflows | Out-Null
Move-Item setup\update-data.yml .github\workflows\update-data.yml
Move-Item setup\update-prices.yml .github\workflows\update-prices.yml
Move-Item setup\update-news.yml .github\workflows\update-news.yml
git init
git add .
git commit -m "Data pipeline"
git branch -M main
git remote add origin https://github.com/Aymankhalifeh/anime-app-data.git
git push -u origin main
```

### 3. Allow the job to save its results
Repository → **Settings** → **Actions** → **General** → *Workflow permissions* →
**Read and write permissions** → **Save**.

### 4. Optional: Arabic stories for new anime
1. Get an API key at console.anthropic.com (add a small credit, e.g. $5; a night costs well under 1 cent).
2. Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Name: `ANTHROPIC_API_KEY`, value: your key → **Add secret**.

Never put the key in a file or in the app. It lives only in GitHub's secrets.

### 5. First run
Repository → **Actions** → **Update app data** → **Run workflow**. It takes about 6–8 minutes.
Afterwards `data/manifest.json` shows today's date.

### 6. Point the app at it
Start the app with your repository's address:
```powershell
flutter run -d web-server --web-port 8080 --dart-define=DATA_BASE_URL=https://raw.githubusercontent.com/YOUR-NAME/anime-app-data/main/data/
```
(Or put the address as `defaultValue` in `app/lib/core/data/data_store.dart`.)

## Notes
- GitHub pauses scheduled jobs in repositories with no activity for 60 days. The nightly data commits count as activity, so this normally never happens; if it does, Actions shows a button to turn it back on.
- To change the style of the Arabic stories, edit `STYLE_GUIDE` in `scripts/build.mjs`.
- To fix a single Arabic story by hand, edit it in `data/synopsis_ar.json` and push; the job keeps existing stories and only adds missing ones.

## Prices (weekly job)

`data/prices.json` holds the streaming services per country with their plan prices,
sorted cheapest first. The app reads it to answer "where can I watch this, and what
does it cost here?".

The job: `scripts/prices.mjs`, scheduled in `.github/workflows/update-prices.yml`
every Sunday at 03:41 UTC. It takes about a minute.

### Why a separate job

Prices are **geo-dependent**: the same Netflix page shows 35 SAR in Riyadh, 110 EGP
in Cairo and 6,99 € in Berlin. So each page has to be fetched *from inside* the
country. GitHub's runners can't pick a country, so the job calls a scraping service
that can.

### Setup (optional but recommended)

1. Create a free account at firecrawl.dev and copy the API key.
2. Repository → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret** → name `FIRECRAWL_API_KEY`.

Each page costs about 1 credit, and a run is ~12 pages, so the free tier lasts a long
time. **Without the key the job still runs**, but every page then comes from GitHub's
own country, the currency check rejects it, and last week's prices are kept.

### The rule: a wrong price is worse than an old price

Nothing reaches the app unless it passes every check:

| Check | Catches |
|---|---|
| Currency must match the country (SAR for SA, EGP for EG…) | the page served US or EUR prices — this really happens, Crunchyroll shows € prices in Saudi Arabia |
| Page must name the country (where the page states it) | geo-targeting silently failed |
| Yearly and promo prices are skipped | "6 months at a discount" being sold as the normal price |
| New price within ±50% of last week's | a redesigned page, half-loaded content, a parsing mistake |

Anything that fails keeps last week's value, is marked `"stale": true`, and is listed
under `needs_check` in `prices.json` and in the job log. Then you look at it yourself.

### Editing prices by hand

Some services have no public pricing page at all (Shahid returns a 404, Prime Video
hides it behind the Amazon sign-up). Those live in `scripts/price-manual.json`:

```json
"SA": { "shahid": { "checked": "2026-10-30", "plans": [
  { "plan": "VIP", "price": 46, "period": "month" }
] } }
```

Add `"lock": true` to an entry and the weekly job will never overwrite it.

### Adding a country or a service

Everything lives in `scripts/price-sources.json`: countries with their currency,
services with their pricing-page URL. Two ways of reading a page:

- `"strategy": "labelled"` — the page writes `Basic: 35 SAR/month` (Netflix).
- `"strategy": "amounts"` — take the cheapest prices on the page and give them the
  plan names listed in `plans` (Disney+, Crunchyroll).

### Testing without the network

`fixtures/` holds saved copies of real pricing pages. Run against them:

```powershell
cd D:\claude\coding\anime-app\data-pipeline
$env:FIXTURES = "$PWD\fixtures"; node scripts/prices.mjs --dry
```

`--dry` prints the result without writing. `--only=netflix` checks one service.

## News (hourly job)

`data/news.json` feeds the app's News tab. The job: `scripts/news.mjs`, scheduled in
`.github/workflows/update-news.yml` every hour at :23. A run takes under a minute.

### Two kinds of news

| Kind | Where from | Language |
|---|---|---|
| New season / new anime announced, official trailer out, release date set | AniList data, compared with the last run (`data/news_state.json`) | The app writes the sentence in the user's language, so Arabic for free |
| Headlines from news sites | Official RSS feeds in `scripts/news-sources.json` | English headline + link; with `ANTHROPIC_API_KEY` also a short Arabic summary |

The first run only remembers what exists; announcements start from the second run on.

### The legal rules the job follows

- Only the **headline, link and source name** are published. The article text and its photos are never copied.
- The Arabic summary is written **in Claude's own words** from the headline and the feed's short teaser (2-3 sentences, facts only). The teaser itself is not published.
- Each source is credited in the app, with the credit line it asks for (Anime News Network: "News provided by Anime News Network").
- One fetch per hour for everyone, not one per app user.

### Adding a source

Add an entry to `scripts/news-sources.json` (`id`, `name`, `feed`, `home`, `credit`, optional
`categories` to keep). Check the site's terms first; for commercial use, ask the site by email.

### Cost of the Arabic summaries

Uses the small model (`claude-haiku-5-5`, change with the `NEWS_MODEL` variable), at most 12
summaries per run. A few hundred short summaries a month cost cents to low euros.

### Testing without the network

```powershell
cd D:\claude\coding\anime-app\data-pipeline
node scripts/news.mjs --dry
```
`--dry` prints the result and writes nothing. With internet this fetches the real feeds and AniList.
