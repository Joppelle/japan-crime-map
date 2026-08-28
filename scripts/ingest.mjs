import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import Papa from "papaparse";

const REPORTING_YEAR = Number(process.env.REPORTING_YEAR ?? 2025);
const MAX_PER_CATEGORY = Number(process.env.MAX_PER_CATEGORY ?? 1200);
const PRIVACY_THRESHOLD = Number(process.env.PRIVACY_THRESHOLD ?? 5);
const OUTPUT_PATH = resolve(process.env.OUTPUT_PATH ?? "public/data/incidents.json");
const ADDRESS_API = "https://japanese-addresses-v2.geoloniamaps.com/api/ja";
const NPA_INDEX = "https://www.npa.go.jp/toukei/seianki/hanzaiopendatalink.html";

const CATEGORIES = [
  ["snatching", "hittakuri"],
  ["vehicle_break_in", "syazyounerai"],
  ["parts_theft", "buhinnerai"],
  ["vending_machine_theft", "zidouhanbaikinerai"],
  ["car_theft", "zidousyatou"],
  ["motorcycle_theft", "ootobaitou"],
  ["bicycle_theft", "zitensyatou"],
];

const PREFECTURES = [
  {
    code: "13",
    name: "東京都",
    slug: "tokyo",
    adapter: "single-page",
    landingUrl:
      "https://www.keishicho.metro.tokyo.lg.jp/about_mpd/jokyo_tokei/jokyo/hanzaihasseijyouhou.html",
  },
  {
    code: "14",
    name: "神奈川県",
    slug: "kanagawa",
    adapter: "single-page",
    landingUrl: "https://www.police.pref.kanagawa.jp/tokei/hanzai_tokei/mesd0145.html",
  },
  {
    code: "27",
    name: "大阪府",
    slug: "osaka",
    adapter: "per-year-page",
    landingUrl: "https://www.police.pref.osaka.lg.jp/seikatsu/9290.html",
  },
  {
    code: "40",
    name: "福岡県",
    slug: "fukuoka",
    adapter: "ckan",
    landingUrl: "https://odcs.bodik.jp/400009/",
  },
  {
    code: "47",
    name: "沖縄県",
    slug: "okinawa",
    adapter: "per-year-page",
    landingUrl: "https://www.police.pref.okinawa.jp/category/bunya/tokei",
  },
];

const requestedNames = new Set(
  (process.env.PREFECTURES ?? PREFECTURES.map(({ name }) => name).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedPrefectures = PREFECTURES.filter(
  ({ name, slug, code }) =>
    requestedNames.has(name) || requestedNames.has(slug) || requestedNames.has(code),
);
if (!selectedPrefectures.length || selectedPrefectures.length !== requestedNames.size) {
  throw new Error(`Unknown PREFECTURES selection: ${[...requestedNames].join(", ")}`);
}

const fetchBytes = async (url) => {
  const response = await fetch(url, {
    headers: { "User-Agent": "japan-crime-map/0.2 (open-data research)" },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

const fetchText = async (url) => new TextDecoder().decode(await fetchBytes(url));
const fetchJson = async (url) => JSON.parse(await fetchText(url));

const decodeHtml = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const extractAnchors = (html, pageUrl) =>
  [...html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)].flatMap(
    ([, , href, content]) => {
      try {
        return [
          {
            url: new URL(decodeHtml(href), pageUrl).href,
            text: decodeHtml(content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
          },
        ];
      } catch {
        return [];
      }
    },
  );

const reiwaYear = (year) => {
  if (year < 2019) throw new Error(`Unsupported reporting year: ${year}`);
  return year - 2018;
};

const findYearPage = async (prefecture) => {
  const anchors = extractAnchors(await fetchText(prefecture.landingUrl), prefecture.landingUrl);
  const era = `令和${reiwaYear(REPORTING_YEAR)}年`;
  const match = anchors.find(
    ({ text }) => text.normalize("NFKC").includes(era) && text.includes("犯罪発生情報"),
  );
  if (!match) throw new Error(`${prefecture.landingUrl}: ${era} publication page not found`);
  return match.url;
};

const discoverCsvLinks = async (prefecture, pageUrl) => {
  const anchors = extractAnchors(await fetchText(pageUrl), pageUrl);
  return CATEGORIES.map(([category, fileSlug]) => {
    const expectedName = `${prefecture.slug}_${REPORTING_YEAR}${fileSlug}.csv`;
    const compactExpectedName = `${prefecture.slug}${REPORTING_YEAR}${fileSlug}.csv`;
    const link = anchors.find(({ url }) => {
      const fileName = decodeURIComponent(basename(new URL(url).pathname)).toLocaleLowerCase();
      return fileName === expectedName || fileName === compactExpectedName;
    });
    if (!link) throw new Error(`${pageUrl}: ${expectedName} not found`);
    return { category, fileSlug, resourceUrl: link.url };
  });
};

const discoverCkanResources = async (prefecture) => {
  const query = new URLSearchParams({
    q: `organization:400009 hanzair_r${reiwaYear(REPORTING_YEAR)}`,
    rows: "10",
  });
  const payload = await fetchJson(`https://data.bodik.jp/api/3/action/package_search?${query}`);
  const dataset = payload.result?.results?.find(
    ({ name }) => name === `400009_hanzair_r${reiwaYear(REPORTING_YEAR)}`,
  );
  if (!dataset) throw new Error(`Fukuoka CKAN dataset not found for ${REPORTING_YEAR}`);
  const resources = CATEGORIES.map(([category, fileSlug]) => {
    const expectedName = `${prefecture.slug}_${REPORTING_YEAR}${fileSlug}.csv`;
    const resource = dataset.resources.find(
      ({ url }) =>
        decodeURIComponent(basename(new URL(url).pathname)).toLocaleLowerCase() === expectedName,
    );
    if (!resource) throw new Error(`${dataset.url ?? dataset.name}: ${expectedName} not found`);
    return { category, fileSlug, resourceUrl: resource.url };
  });
  return {
    resourcePageUrl: `https://data.bodik.jp/dataset/${dataset.id}`,
    resources,
  };
};

const discoverResources = async (prefecture) => {
  if (prefecture.adapter === "ckan") return discoverCkanResources(prefecture);
  const resourcePageUrl =
    prefecture.adapter === "per-year-page"
      ? await findYearPage(prefecture)
      : prefecture.landingUrl;
  return {
    resourcePageUrl,
    resources: await discoverCsvLinks(prefecture, resourcePageUrl),
  };
};

const decodeCsv = (bytes) => {
  const candidates = [
    ["UTF-8", new TextDecoder().decode(bytes)],
    ["CP932/Shift_JIS", new TextDecoder("shift_jis").decode(bytes)],
  ];
  return candidates.reduce((best, candidate) => {
    const replacementCount = (candidate[1].match(/\uFFFD/g) ?? []).length;
    const bestReplacementCount = (best[1].match(/\uFFFD/g) ?? []).length;
    return replacementCount < bestReplacementCount ? candidate : best;
  });
};

const kanjiDigit = (digit) => "〇一二三四五六七八九"[digit];

const numberToKanji = (number) => {
  if (number < 10) return kanjiDigit(number);
  if (number < 20) return `十${number === 10 ? "" : kanjiDigit(number - 10)}`;
  const tens = Math.floor(number / 10);
  const remainder = number % 10;
  return `${kanjiDigit(tens)}十${remainder ? kanjiDigit(remainder) : ""}`;
};

const normalizeAddress = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^大字/, "")
    .replace(/(\d+)丁目/g, (_, value) => `${numberToKanji(Number(value))}丁目`)
    .replaceAll("ケ", "ヶ");

const nullable = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
};

const normalizeDate = (value) => {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  const parts =
    normalized.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/) ??
    normalized.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/) ??
    normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};

const pickEvenly = (rows, limit) => {
  if (!limit || rows.length <= limit) {
    return rows.map((row, sourceRowIndex) => ({ row, sourceRowIndex }));
  }
  return Array.from({ length: limit }, (_, index) => {
    const sourceRowIndex = Math.floor((index * rows.length) / limit);
    return { row: rows[sourceRowIndex], sourceRowIndex };
  });
};

const requiredHeaders = [
  "管轄警察署（発生地）",
  "市区町村（発生地）",
  "町丁目（発生地）",
  "発生年月日（始期）",
  "発生時（始期）",
  "発生場所",
];

const rawRows = [];
const sourceMetadata = [];
let totalRawRows = 0;

for (const prefecture of selectedPrefectures) {
  console.log(`Discovering ${prefecture.name}`);
  const { resourcePageUrl, resources } = await discoverResources(prefecture);
  for (const { category, resourceUrl } of resources) {
    console.log(`Fetching ${prefecture.name} ${category}`);
    const bytes = await fetchBytes(resourceUrl);
    const [encoding, csv] = decodeCsv(bytes);
    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
    });
    if (parsed.errors.length) {
      const fatal = parsed.errors.filter((error) => error.type !== "FieldMismatch").slice(0, 3);
      if (fatal.length) throw new Error(`${resourceUrl}: ${JSON.stringify(fatal)}`);
    }
    const missingHeaders = requiredHeaders.filter(
      (header) => !parsed.meta.fields?.includes(header),
    );
    if (missingHeaders.length) {
      throw new Error(`${resourceUrl}: missing expected headers ${missingHeaders.join(", ")}`);
    }
    const sourceFile = decodeURIComponent(basename(new URL(resourceUrl).pathname));
    totalRawRows += parsed.data.length;
    sourceMetadata.push({
      prefecture: prefecture.name,
      category,
      landingUrl: prefecture.landingUrl,
      resourcePageUrl,
      resourceUrl,
      fileName: sourceFile,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encoding,
      format: "CSV",
      rows: parsed.data.length,
    });
    for (const { row, sourceRowIndex } of pickEvenly(parsed.data, MAX_PER_CATEGORY)) {
      rawRows.push({
        prefecture,
        category,
        resourceUrl,
        sourceFile,
        row,
        sourceRowIndex,
      });
    }
  }
}

const japan = await fetchJson(`${ADDRESS_API}.json`);
const prefectureReferences = new Map();
for (const prefecture of selectedPrefectures) {
  const reference = japan.data.find(({ pref }) => pref === prefecture.name);
  if (!reference) throw new Error(`${prefecture.name} not found in address reference data`);
  prefectureReferences.set(prefecture.name, {
    point: reference.point,
    cityPoints: new Map(reference.cities.map((city) => [city.city, city.point])),
  });
}

const municipalityKeys = [
  ...new Set(
    rawRows
      .map(({ prefecture, row }) => {
        const municipality = nullable(row["市区町村（発生地）"]);
        return municipality ? `${prefecture.name}|${municipality}` : null;
      })
      .filter(Boolean),
  ),
];
const townLookups = new Map();
for (let index = 0; index < municipalityKeys.length; index += 6) {
  const batch = municipalityKeys.slice(index, index + 6);
  const responses = await Promise.all(
    batch.map(async (key) => {
      const [prefecture, municipality] = key.split("|");
      const url = `${ADDRESS_API}/${encodeURIComponent(prefecture)}/${encodeURIComponent(municipality)}.json`;
      try {
        const payload = await fetchJson(url);
        const lookup = new Map();
        for (const address of payload.data) {
          if (!address.point) continue;
          const label = normalizeAddress(`${address.oaza_cho ?? ""}${address.chome ?? ""}`);
          const fallbackLabel = normalizeAddress(address.oaza_cho ?? "");
          if (label) lookup.set(label, address.point);
          if (fallbackLabel && !lookup.has(fallbackLabel)) lookup.set(fallbackLabel, address.point);
        }
        return [key, lookup];
      } catch (error) {
        console.warn(`Address lookup failed for ${key}: ${error.message}`);
        return [key, new Map()];
      }
    }),
  );
  for (const [key, lookup] of responses) townLookups.set(key, lookup);
}

const locationCounts = new Map();
for (const { prefecture, row } of rawRows) {
  const municipality = nullable(row["市区町村（発生地）"]);
  if (!municipality || !normalizeDate(row["発生年月日（始期）"])) continue;
  const key = `${prefecture.name}|${municipality}|${normalizeAddress(row["町丁目（発生地）"])}`;
  locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
}

const incidents = rawRows.flatMap(
  ({ prefecture, category, resourceUrl, sourceFile, row, sourceRowIndex }) => {
    const municipality = nullable(row["市区町村（発生地）"]);
    const rawTown = nullable(row["町丁目（発生地）"]);
    const normalizedTown = normalizeAddress(rawTown);
    if (!municipality) return [];
    const municipalityKey = `${prefecture.name}|${municipality}`;
    const locationKey = `${municipalityKey}|${normalizedTown}`;
    const canPublishTown =
      Boolean(rawTown) && (locationCounts.get(locationKey) ?? 0) >= PRIVACY_THRESHOLD;
    const townPoint = canPublishTown ? townLookups.get(municipalityKey)?.get(normalizedTown) : null;
    const reference = prefectureReferences.get(prefecture.name);
    const point = townPoint ?? reference.cityPoints.get(municipality) ?? reference.point;
    const geocodeLevel = townPoint ? "chome" : "municipality";
    const date = normalizeDate(row["発生年月日（始期）"]);
    if (!date || !point) return [];
    const hourValue = nullable(row["発生時（始期）"]);
    const id = createHash("sha256")
      .update(`${prefecture.code}|${sourceFile}|${sourceRowIndex}|${JSON.stringify(row)}`)
      .digest("hex")
      .slice(0, 20);
    return [
      {
        id,
        category,
        date,
        hour: hourValue === null || Number.isNaN(Number(hourValue)) ? null : Number(hourValue),
        prefecture: prefecture.name,
        municipality,
        town: geocodeLevel === "chome" ? rawTown : null,
        policeStation: nullable(row["管轄警察署（発生地）"]),
        place: nullable(row["発生場所"]),
        longitude: point[0],
        latitude: point[1],
        geocodeLevel,
        geocodeConfidence: townPoint ? "high" : "low",
        sourceUrl: resourceUrl,
        sourceFile,
        reportingYear: REPORTING_YEAR,
      },
    ];
  },
);

incidents.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
const output = {
  metadata: {
    generatedAt: new Date().toISOString(),
    reportingYear: REPORTING_YEAR,
    prefectures: selectedPrefectures.map(({ name }) => name),
    sourceName: "Japanese prefectural police open data",
    sourceUrl: NPA_INDEX,
    addressSource: "Geolonia Japanese Addresses v2 / Digital Agency Address Base Registry",
    publishedRecords: incidents.length,
    rawRecords: totalRawRows,
    isSample: Boolean(MAX_PER_CATEGORY),
    sampleLimitPerCategory: MAX_PER_CATEGORY || null,
    privacyThreshold: PRIVACY_THRESHOLD,
    sources: sourceMetadata,
  },
  incidents,
};

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(output)}\n`);
console.log(`Wrote ${incidents.length} records from ${selectedPrefectures.length} prefectures`);
