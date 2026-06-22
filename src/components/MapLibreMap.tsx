"use client";
import RMap, {
  Source, Layer, NavigationControl, ScaleControl, Popup,
} from "react-map-gl/maplibre";
import type { MapRef, MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { StyleSpecification } from "maplibre-gl";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { errorTypeColor } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

const INITIAL_VIEW = { longitude: -14.5, latitude: 14.5, zoom: 7 };

// Self-contained raster style — no external style.json needed
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      // OSM ne sert des tuiles que jusqu'au zoom 19. Au-delà (parcelles/slivers
      // minuscules), MapLibre agrandit les tuiles z19 au lieu de demander des
      // tuiles z20+ inexistantes (qui provoquaient des erreurs "Failed to fetch").
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface GeoError {
  id: number;
  errorType: string;
  severity: string;
  nicad1?: string | null;
  nicad2?: string | null;
  description?: string | null;
  geometry?: unknown;
  area?: number | null;
  confidence: number;
  corrected: boolean;
}

interface Props {
  geoJson: string | null;
  errors: GeoError[];
  selectedErrorId?: number;
  onFeatureClick?: (props: Record<string, unknown>) => void;
  selectedNicads?: string[];
  searchedNicads?: string[];
  focusTarget?: { nicad: string; key: number } | null;
}

interface PopupState { lng: number; lat: number; html: string }

function extractNicad(props: Record<string, unknown>): string {
  return String(props.NICAD ?? props.nicad ?? props.NIC ?? props.Nicad ?? "");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function computeBbox(features: unknown[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  let found = false;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lng = c[0] as number, lat = c[1] as number;
      if (isFinite(lng) && isFinite(lat)) {
        found = true;
        if (lng < w) w = lng; if (lat < s) s = lat;
        if (lng > e) e = lng; if (lat > n) n = lat;
      }
    } else { for (const i of c) walk(i); }
  };
  for (const feat of features) {
    const f = feat as { geometry?: { coordinates?: unknown } };
    if (f?.geometry?.coordinates) walk(f.geometry.coordinates);
  }
  return found ? [[w, s], [e, n]] : null;
}

export default function MapLibreMap({ geoJson, errors, selectedErrorId, onFeatureClick, selectedNicads = [], searchedNicads = [], focusTarget }: Props) {
  const mapRef = useRef<MapRef>(null);
  const featureMapRef = useRef<Map<string, GeoJSON.Feature>>(new Map());
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onClickRef = useRef(onFeatureClick);
  useEffect(() => { onClickRef.current = onFeatureClick; });

  const [mapReady, setMapReady] = useState(false);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [blinkOpacity, setBlinkOpacity] = useState(0);
  const [blinkColor, setBlinkColor] = useState("#ffffff");
  const [cursor, setCursor] = useState("grab");

  // ── Augmented parcelles GeoJSON ──────────────────────────────────────────
  const augmentedGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!geoJson) { featureMapRef.current = new Map(); return EMPTY_FC; }
    try {
      const fc = JSON.parse(geoJson) as GeoJSON.FeatureCollection;
      const fMap = new Map<string, GeoJSON.Feature>();
      const features = (fc.features ?? []).map((feat) => {
        const props = (feat.properties ?? {}) as Record<string, unknown>;
        const nicad = extractNicad(props);
        const augmented = { ...feat, properties: { ...props, _nicad: nicad } } as GeoJSON.Feature;
        if (nicad) fMap.set(nicad, augmented);
        return augmented;
      });
      featureMapRef.current = fMap;
      return { type: "FeatureCollection", features };
    } catch { return EMPTY_FC; }
  }, [geoJson]);

  // ── Error geometries GeoJSON ──────────────────────────────────────────────
  const errorGeomsFc = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: errors
      .filter((e) => e.geometry)
      .map((e) => ({
        type: "Feature" as const,
        id: e.id,
        geometry: e.geometry as GeoJSON.Geometry,
        properties: {
          _color: errorTypeColor(e.errorType),
          _opacity: e.id === selectedErrorId ? 0.5 : 0.22,
          _selected: e.id === selectedErrorId,
        },
      })),
  }), [errors, selectedErrorId]);

  // ── Blink GeoJSON ─────────────────────────────────────────────────────────
  const blinkFc = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!selectedErrorId) return EMPTY_FC;
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err?.nicad1) return EMPTY_FC;
    const feat = featureMapRef.current.get(err.nicad1);
    return feat ? { type: "FeatureCollection", features: [feat] } : EMPTY_FC;
  }, [errors, selectedErrorId]);

  // ── NiCAD lists per error type ────────────────────────────────────────────
  const nicadsByType = useMemo<Record<string, string[]>>(() => {
    const res: Record<string, string[]> = {};
    for (const e of errors) {
      if (!res[e.errorType]) res[e.errorType] = [];
      if (e.nicad1) res[e.errorType].push(e.nicad1);
      if (e.nicad2) res[e.errorType].push(e.nicad2);
    }
    for (const t in res) res[t] = [...new Set(res[t])];
    return res;
  }, [errors]);
  const errorTypes = useMemo(() => Object.keys(nicadsByType), [nicadsByType]);

  // ── Blink animation ───────────────────────────────────────────────────────
  useEffect(() => {
    if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; }
    if (!selectedErrorId || blinkFc.features.length === 0) { setBlinkOpacity(0); return; }
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err) { setBlinkOpacity(0); return; }
    setBlinkColor(errorTypeColor(err.errorType));
    let bright = true;
    const tick = () => { bright = !bright; setBlinkOpacity(bright ? 0.65 : 0.05); };
    tick();
    blinkTimerRef.current = setInterval(tick, 420);
    return () => { if (blinkTimerRef.current) clearInterval(blinkTimerRef.current); };
  }, [selectedErrorId, blinkFc, errors]);

  // ── Fit bounds on new geoJson (runs also when map becomes ready) ──────────
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map || augmentedGeoJson.features.length === 0) return;
    const bbox = computeBbox(augmentedGeoJson.features);
    if (bbox) map.fitBounds(bbox, { padding: 40, maxZoom: 16, duration: 600 });
  }, [mapReady, augmentedGeoJson]);

  // ── Fit bounds on selected error ──────────────────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map || !selectedErrorId) return;
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err) return;
    const targets: unknown[] = err.geometry
      ? [{ geometry: err.geometry }]
      : err.nicad1 ? [featureMapRef.current.get(err.nicad1)].filter(Boolean) : [];
    if (!targets.length) return;
    const bbox = computeBbox(targets);
    if (bbox) map.fitBounds(bbox, { padding: 80, maxZoom: 18, duration: 600 });
  }, [mapReady, errors, selectedErrorId]);

  // ── Fit bounds on search/focus target ─────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !focusTarget) return;
    const map = mapRef.current;
    const feat = featureMapRef.current.get(focusTarget.nicad);
    if (!map || !feat) return;
    const bbox = computeBbox([feat]);
    if (bbox) map.fitBounds(bbox, { padding: 80, maxZoom: 18, duration: 600 });
  }, [mapReady, focusTarget]);

  // ── Click handler ─────────────────────────────────────────────────────────
  const handleClick = useCallback((e: MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat?.properties) { setPopup(null); return; }
    const props = feat.properties as Record<string, unknown>;
    onClickRef.current?.(props);
    const rows = Object.entries(props)
      .filter(([k]) => !k.startsWith("_"))
      .slice(0, 10)
      .map(([k, v]) =>
        `<div style="display:flex;gap:6px;padding:1px 0">` +
        `<span style="color:#6b7280;width:80px;flex-shrink:0;font-size:10px">${escHtml(k)}</span>` +
        `<span style="color:#111827;word-break:break-all;font-weight:500">${escHtml(String(v ?? ""))}</span></div>`
      ).join("");
    setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, html: rows });
  }, []);

  return (
    <div className="w-full h-full">
      <RMap
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        onClick={handleClick}
        interactiveLayerIds={["parcelles-fill"]}
        onMouseEnter={() => setCursor("pointer")}
        onMouseLeave={() => setCursor("grab")}
        cursor={cursor}
        onLoad={() => setMapReady(true)}
        attributionControl={false}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <ScaleControl position="bottom-left" maxWidth={100} unit="metric" />

        {/* ── Parcelles ── */}
        <Source id="parcelles" type="geojson" data={augmentedGeoJson}>
          <Layer id="parcelles-fill" type="fill" paint={{ "fill-color": "#6b7280", "fill-opacity": 0.22 }} />
          <Layer id="parcelles-line" type="line" paint={{ "line-color": "#9ca3af", "line-width": 0.8, "line-opacity": 0.6 }} />
        </Source>

        {/* ── Error geometry overlays ── */}
        <Source id="error-geoms" type="geojson" data={errorGeomsFc}>
          <Layer
            id="error-geoms-fill"
            type="fill"
            paint={{
              "fill-color": ["coalesce", ["get", "_color"], "#ef4444"] as any,
              "fill-opacity": ["coalesce", ["get", "_opacity"], 0.22] as any,
            }}
          />
          <Layer
            id="error-geoms-line"
            type="line"
            paint={{
              "line-color": ["coalesce", ["get", "_color"], "#ef4444"] as any,
              "line-width": ["case", ["coalesce", ["get", "_selected"], false], 2.5, 1.2] as any,
              "line-opacity": 0.9,
            }}
          />
        </Source>

        {/* ── Blink ── */}
        <Source id="blink" type="geojson" data={blinkFc}>
          <Layer id="blink-fill" type="fill" paint={{ "fill-color": blinkColor, "fill-opacity": blinkOpacity }} />
          <Layer id="blink-line" type="line" paint={{ "line-color": blinkColor, "line-width": 3, "line-opacity": blinkOpacity }} />
        </Source>

        {/* ── Anchor: error type layers insert before this, selection highlight inserts after ── */}
        <Layer
          id="error-type-top"
          source="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#000", "fill-opacity": 0 }}
        />

        {/* ── Error type fill overlays (below anchor) ── */}
        {errorTypes.map((type) => (
          <Layer
            key={`err-${type}`}
            id={`err-${type}`}
            source="parcelles"
            type="fill"
            beforeId="error-type-top"
            paint={{ "fill-color": errorTypeColor(type), "fill-opacity": 0.45 }}
            filter={["in", ["get", "_nicad"], ["literal", nicadsByType[type] ?? []]] as any}
          />
        ))}

        {/* ── Selection highlight (above error types, below error geometries) ── */}
        <Layer
          id="selected-fill"
          source="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.38 }}
          filter={["in", ["get", "_nicad"], ["literal", selectedNicads]] as any}
        />
        <Layer
          id="selected-line"
          source="parcelles"
          type="line"
          beforeId="error-geoms-fill"
          paint={{ "line-color": "#60a5fa", "line-width": 2.5, "line-opacity": 1 }}
          filter={["in", ["get", "_nicad"], ["literal", selectedNicads]] as any}
        />

        {/* ── Searched parcel highlight (yellow) ── */}
        <Layer
          id="searched-fill"
          source="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#facc15", "fill-opacity": 0.45 }}
          filter={["in", ["get", "_nicad"], ["literal", searchedNicads]] as any}
        />
        <Layer
          id="searched-line"
          source="parcelles"
          type="line"
          beforeId="error-geoms-fill"
          paint={{ "line-color": "#eab308", "line-width": 3, "line-opacity": 1 }}
          filter={["in", ["get", "_nicad"], ["literal", searchedNicads]] as any}
        />

        {popup && (
          <Popup
            longitude={popup.lng}
            latitude={popup.lat}
            onClose={() => setPopup(null)}
            closeButton
            maxWidth="260px"
            offset={6}
          >
            <div style={{ fontSize: 11, lineHeight: 1.6, padding: "4px 2px", color: "#111827", background: "#fff" }}
              dangerouslySetInnerHTML={{ __html: popup.html }}
            />
          </Popup>
        )}
      </RMap>
    </div>
  );
}
