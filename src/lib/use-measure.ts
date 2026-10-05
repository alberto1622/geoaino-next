"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LngLat } from "@/lib/measure";

/**
 * use-measure.ts — état de l'outil « Mesurer », commun aux cartes MapLibre et
 * Leaflet : mode actif (Échap pour quitter) et points saisis.
 */

export type MeasureMode = "distance" | "surface" | null;

/** Mode de mesure de la page ; Échap le désactive. */
export function useMeasureMode(): [MeasureMode, (m: MeasureMode | ((prev: MeasureMode) => MeasureMode)) => void] {
  const [mode, setMode] = useState<MeasureMode>(null);
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);
  return [mode, setMode];
}

/**
 * Points de mesure, rattachés au mode qui les a saisis : changer de mode
 * repart de zéro sans effet de synchronisation.
 */
export function useMeasurePoints(mode: MeasureMode) {
  const [state, setState] = useState<{ mode: MeasureMode; pts: LngLat[] }>({ mode: null, pts: [] });
  const pts = useMemo(() => (mode && state.mode === mode ? state.pts : []), [state, mode]);
  const add = useCallback(
    (p: LngLat) => setState((s) => ({ mode, pts: [...(s.mode === mode ? s.pts : []), p] })),
    [mode],
  );
  const undo = useCallback(() => setState({ mode, pts: pts.slice(0, -1) }), [mode, pts]);
  const clear = useCallback(() => setState({ mode, pts: [] }), [mode]);
  return { pts, add, undo, clear };
}

/** Géométries de la mesure : points, ligne (fermée en mode surface), polygone. */
export function measureFeatureCollection(mode: MeasureMode, pts: LngLat[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = pts.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }));
  if (pts.length >= 2) {
    const line = mode === "surface" && pts.length >= 3 ? [...pts, pts[0]] : pts;
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } });
  }
  if (mode === "surface" && pts.length >= 3) {
    features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
  }
  return { type: "FeatureCollection", features };
}

export const MEASURE_COLOR = "#f59e0b";
