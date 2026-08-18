"use client";

import RMap, { Source, Layer, NavigationControl, ScaleControl, Popup } from "react-map-gl/maplibre";
import type { MapRef, MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorTypeColor, severityColor } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

const INITIAL_VIEW = { longitude: -14.5, latitude: 14.5, zoom: 7 };

// Style autonome (raster OSM) — copié de MapLibreMap.tsx (non exporté là-bas,
// duplication volontairement acceptée pour ce petit composant read-only).
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const PARCEL_COLOR = "#64748b";

const POLYGON_TYPES = ["Polygon", "MultiPolygon"];
const LINE_TYPES = ["LineString", "MultiLineString", "Polygon", "MultiPolygon"];
const POINT_TYPES = ["Point", "MultiPoint"];

export interface ErrorRow {
  id: number;
  errorType: string;
  severity: string;
  nicad1: string | null;
  nicad2: string | null;
  description: string | null;
  geometry: unknown;
  corrected: boolean;
}

// Échappement HTML des popups — `nicad`/`description` proviennent du fichier
// importé par l'utilisateur (DXF/SHP), pas d'une source de confiance. Même
// fonction que `MapLibreMap.tsx` (`escHtml`).
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ERROR_TYPE_LABELS: Record<string, string> = {
  overlap: "Chevauchement",
  gap: "Trou",
  sliver: "Esquille",
  duplicate: "Doublon NICAD",
  invalid_geom: "Géométrie invalide",
  boundary_cross: "Sort des limites administratives",
  missing_nicad: "NICAD manquant",
  short_nicad: "NICAD trop court",
  self_intersect: "Auto-intersection",
  section_mismatch: "Incohérence de section",
  multi_numero: "Plusieurs numéros",
};

interface Props {
  /** Fichiers (`Analysis.id`) actuellement sélectionnés — un jeu de tuiles vectorielles par fichier. */
  selectedIds: number[];
  errorsById: Map<number, ErrorRow[]>;
  hiddenTypes: Set<string>;
  /** Emprise combinée [w,s,e,n] des fichiers sélectionnés (via map-meta, sans charger la géométrie). */
  fitBounds: [number, number, number, number] | null;
}

/**
 * Rendu carte de `/cadastre/parcelles` par TUILES VECTORIELLES (MVT), même
 * mécanisme que `/map/[analysisId]` (`MapLibreMap.tsx`) — jamais tout le
 * GeoJSON d'un fichier chargé côté client. Nécessaire ici plus qu'ailleurs :
 * cette page peut cumuler PLUSIEURS fichiers volumineux à la fois.
 */
export default function ParcellesMapLibre({ selectedIds, errorsById, hiddenTypes, fitBounds }: Props) {
  const mapRef = useRef<MapRef | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [cursor, setCursor] = useState("grab");
  const [popup, setPopup] = useState<{ lng: number; lat: number; html: string } | null>(null);

  const tilesUrlFor = useCallback((id: number) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/api/analyses/${id}/tiles/{z}/{x}/{y}?sv=2`;
  }, []);

  // ── Erreurs (petit GeoJSON, une source par fichier) — jamais les parcelles elles-mêmes ──
  const errorFcById = useMemo(() => {
    const map = new Map<number, GeoJSON.FeatureCollection>();
    for (const id of selectedIds) {
      const rows = errorsById.get(id) ?? [];
      map.set(id, {
        type: "FeatureCollection",
        features: rows
          .filter((e) => !e.corrected && e.geometry && !hiddenTypes.has(e.errorType.toLowerCase()))
          .map((e) => ({
            type: "Feature" as const,
            id: e.id,
            geometry: e.geometry as GeoJSON.Geometry,
            properties: { _errId: e.id, _color: errorTypeColor(e.errorType) },
          })),
      });
    }
    return map;
  }, [selectedIds, errorsById, hiddenTypes]);

  const interactiveLayerIds = useMemo(
    () =>
      selectedIds.flatMap((id) => [
        `parcelles-fill-${id}`,
        `errors-fill-${id}`,
        `errors-line-${id}`,
        `errors-circle-${id}`,
      ]),
    [selectedIds],
  );

  useEffect(() => {
    if (!mapReady || !fitBounds) return;
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(
      [[fitBounds[0], fitBounds[1]], [fitBounds[2], fitBounds[3]]],
      { padding: 40, maxZoom: 16, duration: 600 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, fitBounds]);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) {
        setPopup(null);
        return;
      }
      const layerId = feature.layer?.id ?? "";
      if (layerId.startsWith("errors-")) {
        const errId = feature.properties?._errId;
        for (const rows of errorsById.values()) {
          const err = rows.find((r) => r.id === errId);
          if (err) {
            const label = ERROR_TYPE_LABELS[err.errorType.toLowerCase()] ?? err.errorType;
            setPopup({
              lng: e.lngLat.lng,
              lat: e.lngLat.lat,
              html:
                `<b>${escHtml(label)}</b> <span class="${severityColor(err.severity)}">(${escHtml(err.severity.toLowerCase())})</span><br/>${escHtml(err.description ?? "")}` +
                (err.nicad1 ? `<br/><span class="font-mono">${escHtml(err.nicad1)}${err.nicad2 ? ` / ${escHtml(err.nicad2)}` : ""}</span>` : ""),
            });
            return;
          }
        }
        return;
      }
      if (layerId.startsWith("parcelles-fill-")) {
        const nicad = feature.properties?._nicad;
        setPopup({
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
          html: nicad ? `<span class="font-mono">${escHtml(String(nicad))}</span>` : "<i>Sans NICAD</i>",
        });
      }
    },
    [errorsById],
  );

  return (
    <RMap
      ref={mapRef}
      initialViewState={INITIAL_VIEW}
      style={{ width: "100%", height: "100%" }}
      mapStyle={MAP_STYLE}
      onClick={handleClick}
      interactiveLayerIds={interactiveLayerIds}
      onMouseEnter={() => setCursor("pointer")}
      onMouseLeave={() => setCursor("grab")}
      cursor={cursor}
      onLoad={() => setMapReady(true)}
      attributionControl={false}
    >
      <NavigationControl position="top-right" showCompass={false} />
      <ScaleControl position="bottom-left" maxWidth={100} unit="metric" />

      {selectedIds.map((id) => (
        <Source key={`parcelles-${id}`} id={`parcelles-${id}`} type="vector" tiles={[tilesUrlFor(id)]} minzoom={0} maxzoom={20}>
          <Layer id={`parcelles-fill-${id}`} source-layer="parcelles" type="fill" paint={{ "fill-color": PARCEL_COLOR, "fill-opacity": 0.08 }} />
          <Layer id={`parcelles-line-${id}`} source-layer="parcelles" type="line" paint={{ "line-color": PARCEL_COLOR, "line-width": 1, "line-opacity": 0.5 }} />
        </Source>
      ))}

      {selectedIds.map((id) => (
        <Source key={`errors-${id}`} id={`errors-${id}`} type="geojson" data={errorFcById.get(id) ?? { type: "FeatureCollection", features: [] }}>
          <Layer
            id={`errors-fill-${id}`}
            type="fill"
            filter={["in", ["geometry-type"], ["literal", POLYGON_TYPES]] as any}
            paint={{ "fill-color": ["get", "_color"], "fill-opacity": 0.45 } as any}
          />
          <Layer
            id={`errors-line-${id}`}
            type="line"
            filter={["in", ["geometry-type"], ["literal", LINE_TYPES]] as any}
            paint={{ "line-color": ["get", "_color"], "line-width": 1.5, "line-opacity": 0.9 } as any}
          />
          <Layer
            id={`errors-circle-${id}`}
            type="circle"
            filter={["in", ["geometry-type"], ["literal", POINT_TYPES]] as any}
            paint={{ "circle-color": ["get", "_color"], "circle-radius": 5, "circle-opacity": 0.7 } as any}
          />
        </Source>
      ))}

      {popup && (
        <Popup longitude={popup.lng} latitude={popup.lat} closeButton onClose={() => setPopup(null)} maxWidth="260px">
          <div dangerouslySetInnerHTML={{ __html: popup.html }} />
        </Popup>
      )}
    </RMap>
  );
}
