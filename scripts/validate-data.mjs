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

if (!Array.isArray(dataset.incidents) || dataset.incidents.length === 0) {
  throw new Error("Dataset has no incidents");
}

for (const incident of dataset.incidents) {
  if (ids.has(incident.id)) throw new Error(`Duplicate incident ID: ${incident.id}`);
  ids.add(incident.id);
  if (!categories.has(incident.category)) throw new Error(`Unknown category: ${incident.category}`);
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
    const key = `${incident.prefecture}|${incident.municipality}|${incident.town}`;
    locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
  }
}

for (const [location, count] of locationCounts) {
  if (count < dataset.metadata.privacyThreshold) {
    throw new Error(`${location} has ${count} records, below the privacy threshold`);
  }
}

for (const source of dataset.metadata.sources ?? []) {
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error(`Invalid source SHA-256: ${source.fileName}`);
  }
}

console.log(
  `Validated ${dataset.incidents.length} public records and ${ids.size} unique IDs from ${dataset.metadata.sources.length} sources`,
);
