import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Papa from "papaparse";

const REPORTING_YEAR = Number(process.env.REPORTING_YEAR ?? 2025);
const MAX_PER_CATEGORY = Number(process.env.MAX_PER_CATEGORY ?? 1200);
const PRIVACY_THRESHOLD = Number(process.env.PRIVACY_THRESHOLD ?? 5);
const OUTPUT_PATH = resolve(process.env.OUTPUT_PATH ?? "public/data/incidents.json");
const SOURCE_PAGE =
  "https://www.keishicho.metro.tokyo.lg.jp/about_mpd/jokyo_tokei/jokyo/hanzaihasseijyouhou.html";
const SOURCE_ROOT =
  "https://www.keishicho.metro.tokyo.lg.jp/about_mpd/jokyo_tokei/jokyo/hanzaihasseijyouhou.files";
const ADDRESS_API = "https://japanese-addresses-v2.geoloniamaps.com/api/ja";

const SOURCES = [
  ["snatching", "hittakuri"],
  ["vehicle_break_in", "syazyounerai"],
  ["parts_theft", "buhinnerai"],
  ["vending_machine_theft", "zidouhanbaikinerai"],
  ["car_theft", "zidousyatou"],
  ["motorcycle_theft", "ootobaitou"],
  ["bicycle_theft", "zitensyatou"],
];

const fetchBytes = async (url) => {
  const response = await fetch(url, {
    headers: { "User-Agent": "japan-crime-map/0.1 (open-data research)" },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

const fetchJson = async (url) => JSON.parse(new TextDecoder().decode(await fetchBytes(url)));

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

const sourceUrl = (slug) => `${SOURCE_ROOT}/tokyo_${REPORTING_YEAR}${slug}.csv`;

const rawRows = [];
const sourceMetadata = [];
let totalRawRows = 0;
for (const [category, slug] of SOURCES) {
  const url = sourceUrl(slug);
  console.log(`Fetching ${category}`);
  const bytes = await fetchBytes(url);
  const csv = new TextDecoder("shift_jis").decode(bytes);
  const parsed = Papa.parse(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
  });
  if (parsed.errors.length) {
    const fatal = parsed.errors.filter((error) => error.type !== "FieldMismatch").slice(0, 3);
    if (fatal.length) throw new Error(`${url}: ${JSON.stringify(fatal)}`);
  }
  const requiredHeaders = [
    "管轄警察署（発生地）",
    "市区町村（発生地）",
    "町丁目（発生地）",
    "発生年月日（始期）",
    "発生時（始期）",
    "発生場所",
  ];
  const missingHeaders = requiredHeaders.filter((header) => !parsed.meta.fields?.includes(header));
  if (missingHeaders.length) {
    throw new Error(`${url}: missing expected headers ${missingHeaders.join(", ")}`);
  }
  totalRawRows += parsed.data.length;
  sourceMetadata.push({
    category,
    resourceUrl: url,
    fileName: `tokyo_${REPORTING_YEAR}${slug}.csv`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    encoding: "CP932/Shift_JIS",
    format: "CSV",
    rows: parsed.data.length,
  });
  const rows = pickEvenly(parsed.data, MAX_PER_CATEGORY);
  for (const { row, sourceRowIndex } of rows) {
    rawRows.push({ category, slug, url, row, sourceRowIndex });
  }
}

const japan = await fetchJson(`${ADDRESS_API}.json`);
const tokyo = japan.data.find((prefecture) => prefecture.pref === "東京都");
if (!tokyo) throw new Error("Tokyo not found in address reference data");
const cityPoints = new Map(tokyo.cities.map((city) => [city.city, city.point]));
const municipalities = [...new Set(rawRows.map(({ row }) => row["市区町村（発生地）"]).filter(Boolean))];

const townLookups = new Map();
for (let index = 0; index < municipalities.length; index += 6) {
  const batch = municipalities.slice(index, index + 6);
  const responses = await Promise.all(
    batch.map(async (municipality) => {
      const url = `${ADDRESS_API}/${encodeURIComponent("東京都")}/${encodeURIComponent(municipality)}.json`;
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
        return [municipality, lookup];
      } catch (error) {
        console.warn(`Address lookup failed for ${municipality}: ${error.message}`);
        return [municipality, new Map()];
      }
    }),
  );
  for (const [municipality, lookup] of responses) townLookups.set(municipality, lookup);
}

const locationCounts = new Map();
for (const { row } of rawRows) {
  const key = `${row["市区町村（発生地）"]}|${normalizeAddress(row["町丁目（発生地）"])}`;
  locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
}

const incidents = rawRows.flatMap(({ category, slug, url, row, sourceRowIndex }) => {
  const municipality = nullable(row["市区町村（発生地）"]);
  const rawTown = nullable(row["町丁目（発生地）"]);
  const normalizedTown = normalizeAddress(rawTown);
  if (!municipality) return [];
  const locationKey = `${municipality}|${normalizedTown}`;
  const canPublishTown = Boolean(rawTown) && (locationCounts.get(locationKey) ?? 0) >= PRIVACY_THRESHOLD;
  const townPoint = canPublishTown ? townLookups.get(municipality)?.get(normalizedTown) : null;
  const point = townPoint ?? cityPoints.get(municipality) ?? tokyo.point;
  const geocodeLevel = townPoint ? "chome" : "municipality";
  const date = normalizeDate(row["発生年月日（始期）"]);
  if (!date || !point) return [];
  const hourValue = nullable(row["発生時（始期）"]);
  const sourceFile = `tokyo_${REPORTING_YEAR}${slug}.csv`;
  const id = createHash("sha256")
    .update(`${sourceFile}|${sourceRowIndex}|${JSON.stringify(row)}`)
    .digest("hex")
    .slice(0, 20);
  return [
    {
      id,
      category,
      date,
      hour: hourValue === null || Number.isNaN(Number(hourValue)) ? null : Number(hourValue),
      prefecture: "東京都",
      municipality,
      town: geocodeLevel === "chome" ? rawTown : null,
      policeStation: nullable(row["管轄警察署（発生地）"]),
      place: nullable(row["発生場所"]),
      longitude: point[0],
      latitude: point[1],
      geocodeLevel,
      geocodeConfidence: townPoint ? "high" : "low",
      sourceUrl: url,
      sourceFile,
      reportingYear: REPORTING_YEAR,
    },
  ];
});

incidents.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
const output = {
  metadata: {
    generatedAt: new Date().toISOString(),
    reportingYear: REPORTING_YEAR,
    sourceName: "Tokyo Metropolitan Police Department",
    sourceUrl: SOURCE_PAGE,
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
console.log(`Wrote ${incidents.length} records to ${OUTPUT_PATH}`);
