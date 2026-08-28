"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import { CATEGORY_META, CrimeCategory, Incident, IncidentDataset } from "@/lib/types";

const ALL_CATEGORIES = Object.keys(CATEGORY_META) as CrimeCategory[];

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    openstreetmap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "openstreetmap", type: "raster", source: "openstreetmap" }],
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function toGeoJson(incidents: Incident[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: incidents.map((incident) => ({
      type: "Feature",
      id: incident.id,
      geometry: {
        type: "Point",
        coordinates: [incident.longitude, incident.latitude],
      },
      properties: {
        id: incident.id,
        category: incident.category,
        color: CATEGORY_META[incident.category].color,
      },
    })),
  };
}

export default function CrimeMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [dataset, setDataset] = useState<IncidentDataset | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<CrimeCategory[]>(ALL_CATEGORIES);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/incidents.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Data request failed (${response.status})`);
        }
        return response.json() as Promise<IncidentDataset>;
      })
      .then(setDataset)
      .catch((error: Error) => {
        if (error.name !== "AbortError") {
          setDataError(error.message);
        }
      });
    return () => controller.abort();
  }, []);

  const filteredIncidents = useMemo(() => {
    if (!dataset) return [];
    const normalizedQuery = query.trim().normalize("NFKC").toLocaleLowerCase("ja");
    return dataset.incidents.filter((incident) => {
      if (!selectedCategories.includes(incident.category)) return false;
      if (!normalizedQuery) return true;
      return `${incident.prefecture} ${incident.municipality} ${incident.town ?? ""} ${incident.policeStation ?? ""}`
        .normalize("NFKC")
        .toLocaleLowerCase("ja")
        .includes(normalizedQuery);
    });
  }, [dataset, query, selectedCategories]);

  const selectedIncident = useMemo(
    () => filteredIncidents.find((incident) => incident.id === selectedId) ?? null,
    [filteredIncidents, selectedId],
  );

  const selectIncident = useCallback((incident: Incident) => {
    setSelectedId(incident.id);
    mapRef.current?.flyTo({
      center: [incident.longitude, incident.latitude],
      zoom: Math.max(mapRef.current.getZoom(), 13),
      essential: true,
    });
  }, []);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: [134.5, 33.8],
      zoom: 4.2,
      minZoom: 3.5,
      maxZoom: 18,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(
      new maplibregl.AttributionControl({ compact: true, customAttribution: "Japan Crime Atlas" }),
      "bottom-right",
    );

    map.on("load", () => {
      map.addSource("incidents", {
        type: "geojson",
        data: toGeoJson([]),
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 42,
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "incidents",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#17324d",
            100,
            "#0b6477",
            500,
            "#009f93",
          ],
          "circle-radius": ["step", ["get", "point_count"], 18, 100, 23, 500, 29],
          "circle-stroke-width": 3,
          "circle-stroke-color": "rgba(255,255,255,.82)",
        },
      });
      map.addLayer({
        id: "incident-points",
        type: "circle",
        source: "incidents",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.9,
        },
      });

      map.on("click", "clusters", async (event: MapMouseEvent) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ["clusters"] })[0];
        const clusterId = feature?.properties?.cluster_id;
        const coordinates = (feature?.geometry as GeoJSON.Point | undefined)?.coordinates;
        if (clusterId === undefined || !coordinates) return;
        const zoom = await (map.getSource("incidents") as GeoJSONSource).getClusterExpansionZoom(
          clusterId,
        );
        map.easeTo({ center: [coordinates[0], coordinates[1]], zoom });
      });

      map.on("click", "incident-points", (event: MapMouseEvent) => {
        const id = map.queryRenderedFeatures(event.point, { layers: ["incident-points"] })[0]
          ?.properties?.id;
        if (id) setSelectedId(id);
      });

      for (const layer of ["clusters", "incident-points"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      (map.getSource("incidents") as GeoJSONSource | undefined)?.setData(
        toGeoJson(filteredIncidents),
      );
    };
    if (map.isStyleLoaded()) update();
    else map.once("load", update);
  }, [filteredIncidents]);

  const toggleCategory = (category: CrimeCategory) => {
    setSelectedCategories((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
  };

  const counts = useMemo(() => {
    const result = Object.fromEntries(ALL_CATEGORIES.map((category) => [category, 0])) as Record<
      CrimeCategory,
      number
    >;
    for (const incident of dataset?.incidents ?? []) result[incident.category] += 1;
    return result;
  }, [dataset]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            犯
          </span>
          <div>
            <p className="eyebrow">Open data observatory</p>
            <h1>Japan Crime Atlas</h1>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="live-dot" aria-hidden="true" />
          <span>2025 annual records</span>
          <a
            href="https://www.npa.go.jp/toukei/seianki/hanzaiopendatalink.html"
            target="_blank"
            rel="noreferrer"
          >
            NPA source ↗
          </a>
        </div>
      </header>

      <section className="workspace">
        <aside className={panelOpen ? "sidebar" : "sidebar sidebar-collapsed"}>
          <button
            className="panel-toggle"
            type="button"
            aria-label={panelOpen ? "Close filter panel" : "Open filter panel"}
            onClick={() => setPanelOpen((value) => !value)}
          >
            {panelOpen ? "←" : "→"}
          </button>
          {panelOpen && (
            <div className="sidebar-content">
              <div className="intro">
                <p className="eyebrow">Five prefectures · 5都府県</p>
                <h2>Reported property crime, mapped with context.</h2>
                <p>
                  Explore seven theft categories from Tokyo, Kanagawa, Osaka, Fukuoka, and Okinawa.
                  Locations are privacy-conscious representative points, not exact incident
                  coordinates.
                </p>
              </div>

              <label className="search-field">
                <span>Search area or police station</span>
                <div>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="6" />
                    <path d="m16 16 4 4" />
                  </svg>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="e.g. Osaka / 大阪"
                  />
                </div>
              </label>

              <section className="filter-section">
                <div className="section-heading">
                  <h3>Crime categories</h3>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedCategories(
                        selectedCategories.length === ALL_CATEGORIES.length ? [] : ALL_CATEGORIES,
                      )
                    }
                  >
                    {selectedCategories.length === ALL_CATEGORIES.length ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="category-list">
                  {ALL_CATEGORIES.map((category) => {
                    const meta = CATEGORY_META[category];
                    const active = selectedCategories.includes(category);
                    return (
                      <button
                        className={active ? "category active" : "category"}
                        key={category}
                        type="button"
                        onClick={() => toggleCategory(category)}
                        aria-pressed={active}
                      >
                        <span className="category-swatch" style={{ background: meta.color }} />
                        <span className="category-name">
                          <strong>{meta.en}</strong>
                          <small>{meta.ja}</small>
                        </span>
                        <span className="category-count">{counts[category].toLocaleString()}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="results-section">
                <div className="section-heading">
                  <h3>Visible records</h3>
                  <span>{filteredIncidents.length.toLocaleString()}</span>
                </div>
                <div className="incident-list">
                  {filteredIncidents.slice(0, 80).map((incident) => (
                    <button
                      className={
                        incident.id === selectedId ? "incident-row selected" : "incident-row"
                      }
                      type="button"
                      key={incident.id}
                      onClick={() => selectIncident(incident)}
                    >
                      <span
                        className="row-marker"
                        style={{ background: CATEGORY_META[incident.category].color }}
                      />
                      <span>
                        <strong>{CATEGORY_META[incident.category].en}</strong>
                        <small>
                          {incident.municipality}
                          {incident.town ? ` · ${incident.town}` : ""}
                        </small>
                      </span>
                      <time>{incident.date.slice(5).replace("-", ".")}</time>
                    </button>
                  ))}
                  {filteredIncidents.length > 80 && (
                    <p className="list-note">Zoom or filter to inspect more records.</p>
                  )}
                </div>
              </section>
            </div>
          )}
        </aside>

        <div className="map-stage">
          <div ref={mapContainer} className="map" aria-label="Interactive crime incident map" />
          <div className="map-status">
            <span className="status-number">
              {filteredIncidents.length.toLocaleString()}
            </span>
            <span>published records</span>
            <i />
            <span>
              {dataset?.metadata.prefectures.length ?? "—"} prefectures ·{" "}
              {dataset?.metadata.reportingYear ?? "—"}
            </span>
          </div>

          {!dataset && !dataError && <div className="loading-card">Preparing the atlas…</div>}
          {dataError && <div className="loading-card error-card">{dataError}</div>}

          <div className="precision-notice">
            <span aria-hidden="true">◎</span>
            <p>
              <strong>Location precision</strong>
              Points show town/chome or municipality representative locations. They do not show
              exact incident sites.
            </p>
          </div>

          {selectedIncident && (
            <article className="detail-card">
              <button
                className="detail-close"
                type="button"
                aria-label="Close incident detail"
                onClick={() => setSelectedId(null)}
              >
                ×
              </button>
              <div className="detail-category">
                <span style={{ background: CATEGORY_META[selectedIncident.category].color }} />
                {CATEGORY_META[selectedIncident.category].en}
              </div>
              <h2>
                {selectedIncident.municipality}
                {selectedIncident.town ? `, ${selectedIncident.town}` : ""}
              </h2>
              <p className="detail-japanese">
                {CATEGORY_META[selectedIncident.category].ja} · {selectedIncident.prefecture}
              </p>
              <dl>
                <div>
                  <dt>Reported date</dt>
                  <dd>{formatDate(selectedIncident.date)}</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>
                    {selectedIncident.hour === null
                      ? "Unknown"
                      : `${String(selectedIncident.hour).padStart(2, "0")}:00`}
                  </dd>
                </div>
                <div>
                  <dt>Place type</dt>
                  <dd>{selectedIncident.place ?? "Not stated"}</dd>
                </div>
                <div>
                  <dt>Police station</dt>
                  <dd>{selectedIncident.policeStation ?? "Not stated"}</dd>
                </div>
              </dl>
              <div className="confidence">
                <span>{selectedIncident.geocodeLevel === "chome" ? "町丁目" : "市区町村"}</span>
                Representative point · {selectedIncident.geocodeConfidence} match confidence
              </div>
              <a href={selectedIncident.sourceUrl} target="_blank" rel="noreferrer">
                View official source ↗
              </a>
            </article>
          )}
        </div>
      </section>
    </main>
  );
}
