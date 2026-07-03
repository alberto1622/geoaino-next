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

// Valeurs de NICAD considérées « manquantes » (alignées sur geo-engine).
const MISSING_NICAD_VALUES = [
  "", "null", "undefined", "na", "n/a", "néant", "neant", "aucun", "sans nicad", "0", "-",
];

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
  /** Analyse dont les parcelles sont servies en tuiles vectorielles (MVT). */
  analysisId: number;
  /** Version (updatedAt/hash corrections) : invalide le cache des tuiles côté client. */
  tilesVersion?: string | number | null;
  /** Emprise globale [w,s,e,n] (EPSG:4326) pour le fit initial (via map-meta). */
  initialBounds?: [number, number, number, number] | null;
  errors: GeoError[];
  selectedErrorId?: number;
  /** Clignotement renforcé (plus rapide/opaque/épais) — parcelles à NICAD dupliqué. */
  blinkIntense?: boolean;
  onFeatureClick?: (props: Record<string, unknown>, point?: { lng: number; lat: number }) => void;
  selectedNicads?: string[];
  searchedNicads?: string[];
  focusTarget?: { nicad: string; key: number } | null;
  conformeHighlight?: boolean;
  nonConformeNicads?: string[];
}

interface PopupState { lng: number; lat: number; html: string }

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

export default function MapLibreMap({ analysisId, tilesVersion, initialBounds, errors, selectedErrorId, blinkIntense = false, onFeatureClick, selectedNicads = [], searchedNicads = [], focusTarget, conformeHighlight = false, nonConformeNicads = [] }: Props) {
  const mapRef = useRef<MapRef>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onClickRef = useRef(onFeatureClick);
  useEffect(() => { onClickRef.current = onFeatureClick; });
  // Cache des emprises par NICAD résolues côté serveur (évite de re-fetcher).
  const boundsCacheRef = useRef<Map<string, [[number, number], [number, number]] | null>>(new Map());

  const [mapReady, setMapReady] = useState(false);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [blinkOpacity, setBlinkOpacity] = useState(0);
  const [blinkColor, setBlinkColor] = useState("#ffffff");
  const [cursor, setCursor] = useState("grab");

  // ── URL des tuiles vectorielles ───────────────────────────────────────────
  // Composant client-only (ssr:false) → `window` disponible. `tilesVersion`
  // (updatedAt) invalide le cache navigateur après une correction.
  const tilesUrl = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const v = tilesVersion != null ? `?v=${encodeURIComponent(String(tilesVersion))}` : "";
    return `${origin}/api/analyses/${analysisId}/tiles/{z}/{x}/{y}${v}`;
  }, [analysisId, tilesVersion]);

  // ── Fit sur un NICAD via l'emprise servie par map-meta ─────────────────────
  // Les géométries ne sont plus embarquées côté client : on résout l'emprise
  // d'une parcelle à la demande (mise en cache) pour le focus/recherche/erreur.
  const fitToNicad = useCallback(async (nicad: string) => {
    const map = mapRef.current;
    if (!map || !nicad) return;
    let bounds = boundsCacheRef.current.get(nicad);
    if (bounds === undefined) {
      try {
        const res = await fetch(`/api/analyses/${analysisId}/map-meta?nicad=${encodeURIComponent(nicad)}`);
        const data = (await res.json()) as { bounds: [number, number, number, number] | null };
        bounds = data.bounds
          ? [[data.bounds[0], data.bounds[1]], [data.bounds[2], data.bounds[3]]]
          : null;
      } catch {
        bounds = null;
      }
      boundsCacheRef.current.set(nicad, bounds);
    }
    if (bounds) map.fitBounds(bounds, { padding: 80, maxZoom: 18, duration: 600 });
  }, [analysisId]);

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

  // ── Blink (surlignage clignotant de la parcelle en erreur) ────────────────
  // Plus de géométrie côté client : on cible la parcelle par son `_nicad` dans
  // la source vecteur via un filtre (opacité animée plus bas).
  const blinkNicad = useMemo(() => {
    if (!selectedErrorId) return null;
    return errors.find((e) => e.id === selectedErrorId)?.nicad1 ?? null;
  }, [errors, selectedErrorId]);

  const blinkFilter = useMemo(
    () =>
      (blinkNicad
        ? ["==", ["get", "_nicad"], blinkNicad]
        : ["in", ["get", "_nicad"], ["literal", []]]) as any,
    [blinkNicad]
  );

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

  // Filtre « parcelle conforme » : NICAD d'au moins 8 caractères, non listé comme
  // valeur « vide », et absent des NICAD en erreur. Aligné sur le décompte client.
  const conformeFilter = useMemo(
    () =>
      [
        "all",
        [">=", ["length", ["get", "_nicad"]], 8],
        ["!", ["in", ["downcase", ["get", "_nicad"]], ["literal", MISSING_NICAD_VALUES]]],
        ["!", ["in", ["get", "_nicad"], ["literal", nonConformeNicads]]],
      ] as any,
    [nonConformeNicads]
  );

  // ── Blink animation ───────────────────────────────────────────────────────
  useEffect(() => {
    if (blinkTimerRef.current) { clearInterval(blinkTimerRef.current); blinkTimerRef.current = null; }
    if (!selectedErrorId || !blinkNicad) { setBlinkOpacity(0); return; }
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err) { setBlinkOpacity(0); return; }
    setBlinkColor(errorTypeColor(err.errorType));
    // Clignotement renforcé pour les doublons : plus rapide et plus contrasté.
    const period = blinkIntense ? 200 : 420;
    const hi = blinkIntense ? 0.95 : 0.65;
    const lo = blinkIntense ? 0.25 : 0.05;
    let bright = true;
    const tick = () => { bright = !bright; setBlinkOpacity(bright ? hi : lo); };
    tick();
    blinkTimerRef.current = setInterval(tick, period);
    return () => { if (blinkTimerRef.current) clearInterval(blinkTimerRef.current); };
  }, [selectedErrorId, blinkNicad, errors, blinkIntense]);

  // ── Fit bounds initial (emprise globale via map-meta) ─────────────────────
  useEffect(() => {
    if (!mapReady || !initialBounds) return;
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(
      [[initialBounds[0], initialBounds[1]], [initialBounds[2], initialBounds[3]]],
      { padding: 40, maxZoom: 16, duration: 600 }
    );
  }, [mapReady, initialBounds]);

  // ── Fit bounds on selected error ──────────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !selectedErrorId) return;
    const map = mapRef.current;
    if (!map) return;
    const err = errors.find((e) => e.id === selectedErrorId);
    if (!err) return;
    // L'erreur porte sa propre géométrie (gap/sliver/overlap) → fit direct ;
    // sinon on résout l'emprise de la parcelle nicad1 côté serveur.
    if (err.geometry) {
      const bbox = computeBbox([{ geometry: err.geometry }]);
      if (bbox) map.fitBounds(bbox, { padding: 80, maxZoom: 18, duration: 600 });
    } else if (err.nicad1) {
      void fitToNicad(err.nicad1);
    }
  }, [mapReady, errors, selectedErrorId, fitToNicad]);

  // ── Fit bounds on search/focus target ─────────────────────────────────────
  useEffect(() => {
    if (!mapReady || !focusTarget) return;
    void fitToNicad(focusTarget.nicad);
  }, [mapReady, focusTarget, fitToNicad]);

  // ── Click handler ─────────────────────────────────────────────────────────
  const handleClick = useCallback((e: MapLayerMouseEvent) => {
    const feat = e.features?.[0];
    if (!feat?.properties) { setPopup(null); return; }
    const props = feat.properties as Record<string, unknown>;
    // Le point cliqué (WGS84) est garanti intérieur à la parcelle : sert de
    // localisateur fiable pour la suppression depuis la table attributaire.
    onClickRef.current?.(props, { lng: e.lngLat.lng, lat: e.lngLat.lat });
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

        {/* ── Parcelles (tuiles vectorielles MVT, couche « parcelles ») ── */}
        <Source id="parcelles" type="vector" tiles={[tilesUrl]} minzoom={0} maxzoom={20}>
          <Layer id="parcelles-fill" source-layer="parcelles" type="fill" paint={{ "fill-color": "#6b7280", "fill-opacity": 0.22 }} />
          <Layer id="parcelles-line" source-layer="parcelles" type="line" paint={{ "line-color": "#9ca3af", "line-width": 0.8, "line-opacity": 0.6 }} />
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

        {/* ── Blink (filtre sur _nicad dans la source vecteur) ── */}
        <Layer
          id="blink-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          filter={blinkFilter}
          paint={{ "fill-color": blinkColor, "fill-opacity": blinkOpacity }}
        />
        <Layer
          id="blink-line"
          source="parcelles"
          source-layer="parcelles"
          type="line"
          filter={blinkFilter}
          paint={{ "line-color": blinkColor, "line-width": blinkIntense ? 6 : 3, "line-opacity": blinkOpacity }}
        />

        {/* ── Anchor: error type layers insert before this, selection highlight inserts after ── */}
        <Layer
          id="error-type-top"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#000", "fill-opacity": 0 }}
        />

        {/* ── Parcelles conformes (vert) — surlignage optionnel ──
            Conforme = NICAD valide (≥ 8 car., pas une valeur « vide ») ET absent de
            la liste des NICAD en erreur. Même définition que le décompte « conformes ». ── */}
        {conformeHighlight && (
          <>
            <Layer
              id="conforme-fill"
              source="parcelles"
              source-layer="parcelles"
              type="fill"
              beforeId="error-type-top"
              paint={{ "fill-color": "#22c55e", "fill-opacity": 0.35 }}
              filter={conformeFilter}
            />
            <Layer
              id="conforme-line"
              source="parcelles"
              source-layer="parcelles"
              type="line"
              beforeId="error-type-top"
              paint={{ "line-color": "#16a34a", "line-width": 1, "line-opacity": 0.85 }}
              filter={conformeFilter}
            />
          </>
        )}

        {/* ── Error type fill overlays (below anchor) ── */}
        {errorTypes.map((type) => (
          <Layer
            key={`err-${type}`}
            id={`err-${type}`}
            source="parcelles"
            source-layer="parcelles"
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
          source-layer="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.38 }}
          filter={["in", ["get", "_nicad"], ["literal", selectedNicads]] as any}
        />
        <Layer
          id="selected-line"
          source="parcelles"
          source-layer="parcelles"
          type="line"
          beforeId="error-geoms-fill"
          paint={{ "line-color": "#60a5fa", "line-width": 2.5, "line-opacity": 1 }}
          filter={["in", ["get", "_nicad"], ["literal", selectedNicads]] as any}
        />

        {/* ── Searched parcel highlight (yellow) ── */}
        <Layer
          id="searched-fill"
          source="parcelles"
          source-layer="parcelles"
          type="fill"
          beforeId="error-geoms-fill"
          paint={{ "fill-color": "#facc15", "fill-opacity": 0.45 }}
          filter={["in", ["get", "_nicad"], ["literal", searchedNicads]] as any}
        />
        <Layer
          id="searched-line"
          source="parcelles"
          source-layer="parcelles"
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
