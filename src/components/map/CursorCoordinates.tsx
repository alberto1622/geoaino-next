"use client";
import { useState, useSyncExternalStore } from "react";
import proj4 from "proj4";

/**
 * Coordonnées du curseur sous la carte, comme la barre d'état de QGIS /
 * ArcGIS : UTM zone 28N (EPSG:32628, le système métrique utilisé partout
 * dans l'application — calculs de surface PostGIS, imports) et WGS84.
 *
 * La position vit dans un petit magasin externe (`CursorStore`) et non dans
 * l'état de la carte : un `mousemove` ne re-rend que ce bandeau, pas les
 * gros composants de carte (MapLibreMap, SectionsClient…).
 */

proj4.defs("EPSG:32628", "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs");

export interface CursorStore {
  set(lngLat: { lng: number; lat: number } | null): void;
  subscribe(cb: () => void): () => void;
  get(): { lng: number; lat: number } | null;
}

function createCursorStore(): CursorStore {
  let value: { lng: number; lat: number } | null = null;
  const subs = new Set<() => void>();
  return {
    set(v) {
      if (v === value || (v && value && v.lng === value.lng && v.lat === value.lat)) return;
      value = v;
      subs.forEach((cb) => cb());
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    get: () => value,
  };
}

/** Un magasin par carte, stable pendant toute la vie du composant. */
export function useCursorStore(): CursorStore {
  const [store] = useState(createCursorStore);
  return store;
}

const fmtM = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDeg = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 6, maximumFractionDigits: 6 });

export function CursorCoordinates({ store, className = "" }: { store: CursorStore; className?: string }) {
  const pos = useSyncExternalStore(store.subscribe, store.get, () => null);
  if (!pos) return null;
  const [x, y] = proj4("EPSG:4326", "EPSG:32628", [pos.lng, pos.lat]);
  return (
    <div
      className={`pointer-events-none absolute z-[1000] rounded-md border border-border/60 bg-card/90 px-2.5 py-1 font-mono text-[11px] leading-tight text-foreground shadow-sm backdrop-blur-sm ${className}`}
      aria-live="off"
    >
      <div>
        <span className="text-muted-foreground">UTM 28N</span>{" "}
        X {fmtM.format(x)} · Y {fmtM.format(y)} m
      </div>
      <div className="text-muted-foreground">
        WGS84 {fmtDeg.format(pos.lat)}°, {fmtDeg.format(pos.lng)}° · EPSG:32628
      </div>
    </div>
  );
}
