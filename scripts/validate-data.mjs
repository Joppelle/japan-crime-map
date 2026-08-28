import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.env.DATA_PATH ?? "public/data/incidents.json");
const dataset = JSON.parse(await readFile(path, "utf8"));
const categories = new Set([
  "snatching",
  "vehicle_break_in",
  "parts_theft",
  "vending_machine_theft",
  "car_theft",
  "motorcycle_theft",
  "bicycle_theft",
]);
const ids = new Set();
const locationCounts = new Map();
const forbiddenFields = ["victimGender", "victimAge", "cashLoss", "rawSourceRow"];
const expectedPrefectures = new Set(
  (
    process.env.EXPECTED_PREFECTURES ?? "東京都,神奈川県,大阪府,福岡県,沖縄県"
  ).split(","),
);
const prefectureCategories = new Map();

const kanjiDigit = (digit) => "〇一二三四五六七八九"[digit];
const numberToKanji = (number) => {
  if (number < 10) return kanjiDigit(number);
  if (number < 20) return `十${number === 10 ? "" : kanjiDigit(number - 10)}`;
  const tens = Math.floor(number / 10);
  const remainder = number % 10;
  return `${kanjiDigit(tens)}十${remainder ? kanjiDigit(remainder) : ""}`;
};
const normalizeAddress = (value) =>
  value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^大字/, "")
    .replace(/(\d+)丁目/g, (_, number) => `${numberToKanji(Number(number))}丁目`)
    .replaceAll("ケ", "ヶ");

if (!Array.isArray(dataset.incidents) || dataset.incidents.length === 0) {
  throw new Error("Dataset has no incidents");
}

for (const incident of dataset.incidents) {
  if (ids.has(incident.id)) throw new Error(`Duplicate incident ID: ${incident.id}`);
  ids.add(incident.id);
  if (!categories.has(incident.category)) throw new Error(`Unknown category: ${incident.category}`);
  if (!expectedPrefectures.has(incident.prefecture)) {
    throw new Error(`Unexpected prefecture: ${incident.prefecture}`);
  }
  if (!prefectureCategories.has(incident.prefecture)) {
    prefectureCategories.set(incident.prefecture, new Set());
  }
  prefectureCategories.get(incident.prefecture).add(incident.category);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incident.date)) {
    throw new Error(`Invalid date on ${incident.id}: ${incident.date}`);
  }
  if (
    typeof incident.longitude !== "number" ||
    typeof incident.latitude !== "number" ||
    incident.longitude < 122 ||
    incident.longitude > 154 ||
    incident.latitude < 20 ||
    incident.latitude > 46
  ) {
    throw new Error(`Coordinate outside Japan bounds: ${incident.id}`);
  }
  for (const field of forbiddenFields) {
    if (field in incident) throw new Error(`Public record exposes forbidden field ${field}`);
  }
  if (incident.town) {
    const key = `${incident.prefecture}|${incident.municipality}|${normalizeAddress(incident.town)}`;
    locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
  }
}

if (
  !Array.isArray(dataset.metadata.prefectures) ||
  dataset.metadata.prefectures.length !== expectedPrefectures.size
) {
  throw new Error("Dataset metadata does not list the expected prefectures");
}

for (const prefecture of expectedPrefectures) {
  if (!dataset.metadata.prefectures.includes(prefecture)) {
    throw new Error(`Dataset metadata is missing ${prefecture}`);
  }
  if (prefectureCategories.get(prefecture)?.size !== categories.size) {
    throw new Error(`${prefecture} does not include all seven crime categories`);
  }
}

for (const [location, count] of locationCounts) {
  if (count < dataset.metadata.privacyThreshold) {
    throw new Error(`${location} has ${count} records, below the privacy threshold`);
  }
}

for (const source of dataset.metadata.sources ?? []) {
  if (!expectedPrefectures.has(source.prefecture)) {
    throw new Error(`Source has unexpected prefecture: ${source.fileName}`);
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error(`Invalid source SHA-256: ${source.fileName}`);
  }
}

console.log(
  `Validated ${dataset.incidents.length} public records across ${expectedPrefectures.size} prefectures and ${dataset.metadata.sources.length} sources`,
);
