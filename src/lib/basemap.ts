"use client";
import { useEffect, useState } from "react";
import type { StyleSpecification } from "maplibre-gl";
import type * as Leaflet from "leaflet";
import { OSM_TILE_URL } from "@/lib/tiles-url";

/**
 * basemap.ts — choix du fond de carte, commun à MapLibre et Leaflet.
 *
 * Fond LOCAL (préféré) : tuiles vectorielles servies par /api/tiles (MBTiles
 * Planetiler) + style OpenMapTiles « Positron » de /public/basemap (pas /public/map :
 * ce préfixe est celui de la page carte, protégée par le proxy d'authentification). Ne dépend
 * d'aucun service externe : fonctionne hors ligne (bureau) et n'est pas
 * soumis au bridage du serveur public OSM.
 * Fond de REPLI : tuiles raster OSM publiques, si le MBTiles n'est pas
 * installé (`BASEMAP_MBTILES_PATH` absente côté serveur).
 */

const STYLE_NAME = "positron";

let availability: Promise<boolean> | null = null;

/** Le serveur dispose-t-il du fond local ? (une seule requête par session de page) */
function localBasemapAvailable(): Promise<boolean> {
  availability ??= fetch("/api/tiles/status")
    .then((r) => (r.ok ? r.json() : { available: false }))
    .then((d: { available?: boolean }) => d.available === true)
    .catch(() => false);
  return availability;
}

const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: [OSM_TILE_URL],
      tileSize: 256,
      // OSM ne sert des tuiles que jusqu'au zoom 19 : au-delà, MapLibre
      // agrandit les tuiles z19 au lieu de demander des z20+ inexistantes.
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/**
 * Style MapLibre du fond de carte. Les URL du style local sont relatives à
 * l'application (`{origin}`), MapLibre exigeant des URL absolues.
 */
export async function getBasemapStyle(): Promise<StyleSpecification> {
  if (!(await localBasemapAvailable())) return OSM_STYLE;
  try {
    const res = await fetch(`/basemap/styles/${STYLE_NAME}.json`);
    if (!res.ok) return OSM_STYLE;
    const raw = await res.text();
    return JSON.parse(raw.replaceAll("{origin}", window.location.origin)) as StyleSpecification;
  } catch {
    return OSM_STYLE;
  }
}

/** Hook : style du fond de carte, `null` tant qu'il n'est pas résolu. */
export function useBasemapStyle(): StyleSpecification | null {
  const [style, setStyle] = useState<StyleSpecification | null>(null);
  useEffect(() => {
    let cancelled = false;
    getBasemapStyle().then((s) => {
      if (!cancelled) setStyle(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return style;
}

/**
 * Ajoute le fond de carte à une carte Leaflet : couche MapLibre (tuiles
 * vectorielles) si le fond local est disponible, sinon tuiles raster OSM.
 */
export async function addLeafletBasemap(L: typeof Leaflet, map: Leaflet.Map): Promise<Leaflet.Layer | null> {
  // La carte peut avoir été démontée pendant les requêtes asynchrones.
  const alive = () => map.getContainer()?.isConnected === true;
  if (await localBasemapAvailable()) {
    const style = await getBasemapStyle();
    if (style !== OSM_STYLE) {
      await import("maplibre-gl/dist/maplibre-gl.css");
      const { maplibreGL } = await import("@maplibre/maplibre-gl-leaflet");
      return alive() ? maplibreGL({ style }).addTo(map) : null;
    }
  }
  return alive() ? L.tileLayer(OSM_TILE_URL, { attribution: "© OpenStreetMap", maxZoom: 19 }).addTo(map) : null;
}
