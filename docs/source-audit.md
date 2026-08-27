# 47-prefecture source audit

Audit date: 2026-08-27  
National index: https://www.npa.go.jp/toukei/seianki/hanzaiopendatalink.html

## Coverage

All 47 official links were inspected across eight regional audit agents. The source universe is
approximately 2,600 files across seven categories, eight reporting years, and 47 prefectures.
Steady-state publication is annual, so a mature collector should expect roughly 330 new files per
year rather than a real-time feed.

No current prefectural source exposes latitude or longitude for individual incidents. Records are
row-level reported incidents, usually located by municipality and town/chome. Kagawa previously
published coordinates but removed them in favor of town-level geography.

The strongest initial adapters are Tokyo, Kanagawa, Osaka, Saitama, Fukuoka, Kyoto, Hyogo, and
Okayama. Tokyo is implemented first because one stable page exposes annual links for all seven
categories.

## Source variation

- CP932 and Shift_JIS are common, but encoding must be detected rather than assumed.
- CSV dominates, while Hiroshima also publishes XLSX and Ehime has served TSV content with a `.csv`
  suffix.
- Some files add unnamed index columns.
- Dates can be slash-separated, hyphen-separated, or compact numeric values.
- Municipality codes are not always consistently zero-padded.
- A reporting-year file can contain an incident whose occurrence date is in another year.
- A missing category file can mean zero incidents rather than a failed publication.
- Adjacent aggregate tables can look similar to row-level incident files and must be rejected by
  semantic header validation.

URL templates are not a reliable discovery mechanism. Paths and filenames change, so collectors
must discover current links from the publisher's page or catalog and validate downloaded content.

## Pipeline

1. **Discover** the authoritative landing page and current resources.
2. **Fetch** source bytes and record URL, filename, publication time, fetch time, and SHA-256.
3. **Decode/parse** using content evidence for format, delimiter, encoding, and header shape.
4. **Normalize** source columns without discarding the original row.
5. **Geocode** to a representative administrative point with explicit precision and confidence.
6. **Validate/load** idempotently using stable source-and-row-derived incident IDs.

Recommended adapter families:

1. `CkanAdapter`
2. `DataeyeAdapter`
3. `SinglePageAdapter`
4. `PerYearIndexAdapter`
5. `PerCategoryIndexAdapter`
6. `BrowserAdapter`

## Canonical incident record

| Group | Fields |
| --- | --- |
| Identity | `id`, raw row index |
| Classification | normalized category, raw category, modus |
| Time | occurrence date, raw date, nullable occurrence hour, reporting year |
| Place | prefecture code/name, raw municipality code, normalized municipality code/name, town/chome, police station, koban, place category/detail |
| Modus fields | victim attributes, lock state, cash loss, device or stolen-item attributes |
| Derived geometry | longitude, latitude, geocode level, confidence, method |
| Provenance | landing URL, resource URL, filename, SHA-256, encoding, format, publication/fetch timestamps, raw source row |

Reporting year is provenance metadata and must never overwrite the occurrence year.

## Geocoding and privacy

Normalize address text with Unicode NFKC, full-width digit handling, and Japanese numeral
normalization. Match municipality code plus normalized town/chome against an official or
appropriately licensed reference dataset.

Fallback ladder:

1. town/chome representative point
2. oaza representative point
3. municipality representative point
4. no public geometry

Every geometry must carry `geocode_level`, `geocode_confidence`, and `geocode_method`. A map point
must be labeled as derived, never as an exact incident site.

Do not send incident addresses to third-party geocoding APIs. Do not jitter coordinates: jitter
fabricates precision and can be reversible across repeated records. Suppress or coarsen small groups;
the MVP starts with a threshold of five. Keep records with blank or withheld town fields in a
municipality-level bucket instead of silently dropping them.

For broad public analysis, choropleth or hex-bin views may communicate uncertainty more honestly
than isolated pins.
