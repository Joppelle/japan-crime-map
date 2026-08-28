# Japan Crime Atlas

A privacy-conscious, Google Maps–style explorer for crime incident open data published by Japan's
47 prefectural police organizations.

The current MVP maps seven nationally standardized property-crime categories from Tokyo, Kanagawa,
Osaka, Fukuoka, and Okinawa. It also includes a 47-prefecture source inventory and an autonomous
Devin API runner that expands ingestion coverage one verified adapter at a time.

## What the map means

Prefectural source files do not publish incident latitude or longitude. The map derives
representative points from municipality and town/chome labels using
[Geolonia Japanese Addresses v2](https://github.com/geolonia/japanese-addresses-v2), which is based
on Japan's Address Base Registry.

- A point is **not the exact incident location**.
- Town/chome labels are published only when at least five records share that area in the loaded
  dataset.
- Smaller groups and unmatched addresses fall back to a municipality representative point.
- Reporting year and occurrence year are kept separate because annual files can include incidents
  from a prior year.

The seven categories are snatching, vehicle break-in, parts theft, vending-machine theft, car theft,
motorcycle theft, and bicycle theft.

## Run locally

Requires Node.js 22+ and npm.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

Validate a change:

```bash
npm run check
```

## Refresh map data

The committed browser dataset is a deterministic, bounded sample suitable for a static deployment.
Regenerate all five prefectures from their current official annual CSVs:

```bash
npm run data:all
```

Refresh only Tokyo while developing the shared adapter:

```bash
npm run data:tokyo
```

Configuration:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `REPORTING_YEAR` | `2025` | Annual source page group to fetch |
| `PREFECTURES` | all five | Comma-separated Japanese names, slugs, or prefecture codes |
| `MAX_PER_CATEGORY` | `1200` | Evenly sample each category; use `0` for every row |
| `PRIVACY_THRESHOLD` | `5` | Minimum records before publishing a town/chome label |
| `OUTPUT_PATH` | `public/data/incidents.json` | Generated dataset destination |

The adapters discover links from publisher pages or the Fukuoka CKAN catalog, detect UTF-8 versus
CP932/Shift_JIS, validate source shape, normalize Japanese address text, join representative
coordinates, apply the privacy fallback, and retain source provenance.

## Autonomous Devin workflow

`.github/workflows/devin-ingestion.yml` runs daily. It starts at most one active Devin session and
asks that session to verify and implement a pending prefecture adapter against a real current file.
Sessions are tagged so overlapping scheduled runs do not duplicate work.

Repository configuration:

1. Create a Devin API service-user key with permission to create sessions.
2. Add it as the repository secret `DEVIN_API_KEY`.
3. Add the Devin organization ID as the repository variable `DEVIN_ORG_ID`.
4. Ensure the Devin GitHub integration can read and open pull requests in this repository.
5. Enable the GitHub Actions workflow.

Run a specific prefecture manually from GitHub Actions by entering its Japanese name, such as
`神奈川県`.

The runner uses:

```text
GET  https://api.devin.ai/v1/sessions
POST https://api.devin.ai/v3/organizations/{org_id}/sessions
```

See [Devin API authentication](https://docs.devin.ai/api-reference/authentication) and
[Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions).

## Architecture

```text
NPA source index
  -> discover source pages and files
  -> fetch immutable bytes + provenance
  -> detect format, encoding, delimiter, and header
  -> normalize into the canonical incident record
  -> join a privacy-safe representative location
  -> validate and publish static map data
```

Source adapters are grouped by behavior rather than prefecture:

- CKAN catalog
- DataEye catalog
- single download page
- per-year index
- per-category index
- browser-assisted discovery

The source inventory lives in `data/sources.json`; national audit findings and the normalized model
are in `docs/source-audit.md`.

## Deployment

The application is a standard Next.js app and can be imported into Vercel. The prototype uses the
public OpenStreetMap raster endpoint for development-scale traffic. Before a high-traffic production
launch, configure a tile provider whose terms and capacity match the expected usage.

## Data and attribution

- [National Police Agency crime open-data index](https://www.npa.go.jp/toukei/seianki/hanzaiopendatalink.html)
- [Tokyo Metropolitan Police annual crime occurrence data](https://www.keishicho.metro.tokyo.lg.jp/about_mpd/jokyo_tokei/jokyo/hanzaihasseijyouhou.html)
- [Kanagawa Prefectural Police crime open data](https://www.police.pref.kanagawa.jp/tokei/hanzai_tokei/mesd0145.html)
- [Osaka Prefectural Police crime open data](https://www.police.pref.osaka.lg.jp/seikatsu/9290.html)
- [Fukuoka Prefecture open-data catalog](https://odcs.bodik.jp/400009/)
- [Okinawa Prefectural Police statistics](https://www.police.pref.okinawa.jp/category/bunya/tokei)
- [Geolonia Japanese Addresses v2](https://github.com/geolonia/japanese-addresses-v2)
- Map tiles and cartography © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

Always review the terms published by each prefectural provider before redistributing a full dataset.
