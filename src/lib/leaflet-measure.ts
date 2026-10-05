"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Leaflet est chargé dynamiquement (refs non typées), comme dans les composants hôtes */
import { useEffect, useRef, type RefObject } from "react";
import type { LngLat } from "@/lib/measure";
import { MEASURE_COLOR, type MeasureMode } from "@/lib/use-measure";

const PANE = "measurePane";
const STYLE_ID = "geoaino-measuring-style";

/** Règle CSS du mode mesure, injectée une seule fois (autonome, sans dépendre de globals.css). */
function ensureMeasuringStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    ".geoaino-measuring .leaflet-interactive, .geoaino-measuring .leaflet-marker-icon { pointer-events: none !important; }";
  document.head.appendChild(style);
}

/**
 * Outil « Mesurer » pour une carte Leaflet impérative.
 *
 * Mode actif : chaque clic ajoute un point, le double-clic ne zoome plus,
 * curseur en croix. Les objets cliquables de la carte (tracés, marqueurs)
 * deviennent transparents aux clics via la classe `geoaino-measuring` du
 * conteneur (règle injectée par `ensureMeasuringStyle`) : un clic sur une section ou une commune place
 * un point au lieu d'ouvrir sa fiche. Piège : `pointer-events: none` sur
 * `overlayPane` ne suffit PAS — Leaflet pose `pointer-events` explicitement
 * sur chaque `.leaflet-interactive`, ce qui l'emporte sur la valeur héritée. Les hôtes qui écoutent eux-mêmes
 * `map.on("click")` doivent ignorer le clic tant que `measureMode` est actif.
 */
export function useLeafletMeasure({
  mapRef,
  LRef,
  mode,
  pts,
  onAdd,
}: {
  mapRef: RefObject<any>;
  LRef: RefObject<any>;
  mode: MeasureMode;
  pts: LngLat[];
  onAdd: (p: LngLat) => void;
}): void {
  const onAddRef = useRef(onAdd);
  useEffect(() => {
    onAddRef.current = onAdd;
  }, [onAdd]);
  const groupRef = useRef<any>(null);

  // Activation / désactivation du mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!mode || !map) return;
    const container: HTMLElement = map.getContainer();
    const prevCursor = container.style.cursor;
    const dblWasOn = map.doubleClickZoom?.enabled?.() ?? false;

    ensureMeasuringStyle();
    container.classList.add("geoaino-measuring");
    container.style.cursor = "crosshair";
    map.doubleClickZoom?.disable?.();
    const onClick = (e: { latlng: { lat: number; lng: number } }) => onAddRef.current([e.latlng.lng, e.latlng.lat]);
    map.on("click", onClick);

    return () => {
      map.off("click", onClick);
      container.classList.remove("geoaino-measuring");
      container.style.cursor = prevCursor;
      if (dblWasOn) map.doubleClickZoom?.enable?.();
    };
  }, [mode, mapRef]);

  // Dessin.
  useEffect(() => {
    const map = mapRef.current;
    const L = LRef.current;
    if (!map || !L) return;
    if (!map.getPane(PANE)) {
      const pane = map.createPane(PANE);
      pane.style.zIndex = "650";
      pane.style.pointerEvents = "none";
    }
    groupRef.current ??= L.layerGroup().addTo(map);
    const group = groupRef.current;
    group.clearLayers();
    if (!mode || pts.length === 0) return;

    const latlngs = pts.map(([lng, lat]) => [lat, lng]);
    const style = { pane: PANE, color: MEASURE_COLOR, weight: 2.5, dashArray: "6 4", interactive: false };
    if (mode === "surface" && pts.length >= 3) {
      L.polygon(latlngs, { ...style, fillColor: MEASURE_COLOR, fillOpacity: 0.18 }).addTo(group);
    } else if (pts.length >= 2) {
      L.polyline(latlngs, style).addTo(group);
    }
    latlngs.forEach((ll) =>
      L.circleMarker(ll, { pane: PANE, radius: 4, color: MEASURE_COLOR, weight: 2, fillColor: "#ffffff", fillOpacity: 1, interactive: false }).addTo(group),
    );
  }, [mode, pts, mapRef, LRef]);
}
