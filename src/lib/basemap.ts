"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { StyleSpecification } from "maplibre-gl";
import type * as Leaflet from "leaflet";
import { OSM_TILE_URL } from "@/lib/tiles-url";

/**
 * basemap.ts — choix du fond de carte, commun à MapLibre et Leaflet.
 *
 * Fonds LOCAUX (préférés) : tuiles vectorielles servies par /api/tiles (MBTiles
 * Planetiler) + styles OpenMapTiles « Positron » (clair) et « Dark Matter »
 * (sombre) de /public/basemap (pas /public/map : ce préfixe est celui de la
 * page carte, protégée par le proxy d'authentification). Ne dépendent d'aucun
 * service externe : fonctionnent hors ligne (bureau) et ne sont pas soumis au
 * bridage du serveur public OSM.
 * Fond OSM : tuiles raster publiques, en ligne uniquement — choix explicite de
 * l'utilisateur, ou repli automatique si le MBTiles n'est pas installé
 * (`BASEMAP_MBTILES_PATH` absente côté serveur).
 *
 * Le choix est partagé par toutes les cartes et mémorisé dans le navigateur.
 */

export type BasemapId = "clair" | "sombre" | "osm";

export const BASEMAPS: { id: BasemapId; label: string; title: string }[] = [
  { id: "clair", label: "Clair", title: "Fond clair (hors ligne)" },
  { id: "sombre", label: "Sombre", title: "Fond sombre (hors ligne)" },
  { id: "osm", label: "OSM", title: "OpenStreetMap standard (connexion Internet requise)" },
];

const STYLE_FILE: Record<Exclude<BasemapId, "osm">, string> = { clair: "positron", sombre: "dark-matter" };
const STORAGE_KEY = "geoaino.basemap";
const DEFAULT_ID: BasemapId = "clair";

// ── Choix courant (magasin partagé, persistant) ─────────────────────────────

const listeners = new Set<() => void>();
let current: BasemapId | null = null;

function readStored(): BasemapId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "clair" || v === "sombre" || v === "osm") return v;
  } catch {
    /* stockage indisponible (navigation privée…) : choix par défaut */
  }
  return DEFAULT_ID;
}

function getBasemapId(): BasemapId {
  current ??= readStored();
  return current;
}

export function setBasemapId(id: BasemapId): void {
  if (id === getBasemapId()) return;
  current = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* préférence non mémorisée, sans conséquence */
  }
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Hook : fond de carte choisi (rendu serveur : fond par défaut). */
export function useBasemapId(): BasemapId {
  return useSyncExternalStore(subscribe, getBasemapId, () => DEFAULT_ID);
}

// ── Disponibilité du fond local ─────────────────────────────────────────────

let availability: Promise<boolean> | null = null;

/** Le serveur dispose-t-il du fond local ? (une seule requête par session de page) */
function localBasemapAvailable(): Promise<boolean> {
  availability ??= fetch("/api/tiles/status")
    .then((r) => (r.ok ? r.json() : { available: false }))
    .then((d: { available?: boolean }) => d.available === true)
    .catch(() => false);
  return availability;
}

/** Hook : `true`/`false` une fois connu, `null` avant. */
export function useLocalBasemapAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    localBasemapAvailable().then((a) => {
      if (!cancelled) setAvailable(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

// ── Styles ──────────────────────────────────────────────────────────────────

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

const styleCache = new Map<string, Promise<StyleSpecification | null>>();

function loadLocalStyle(file: string): Promise<StyleSpecification | null> {
  let p = styleCache.get(file);
  if (!p) {
    p = fetch(`/basemap/styles/${file}.json`)
      .then((res) => (res.ok ? res.text() : null))
      // URL du style relatives à l'application ({origin}) : MapLibre exige des URL absolues.
      .then((raw) => (raw ? (JSON.parse(raw.replaceAll("{origin}", window.location.origin)) as StyleSpecification) : null))
      .catch(() => null);
    styleCache.set(file, p);
  }
  return p;
}

/** Style MapLibre du fond `id` ; OSM si le fond local est indisponible. */
export async function getBasemapStyle(id: BasemapId = getBasemapId()): Promise<StyleSpecification> {
  if (id === "osm" || !(await localBasemapAvailable())) return OSM_STYLE;
  return (await loadLocalStyle(STYLE_FILE[id])) ?? OSM_STYLE;
}

/**
 * Hook : style du fond de carte choisi, `null` tant qu'il n'est pas résolu.
 * Un changement de fond remplace le style ; `react-map-gl` rajoute alors les
 * couches déclarées en JSX (`<Source>`/`<Layer>`) — ne jamais ajouter de
 * couche applicative par `map.addLayer`, elle serait perdue au changement.
 */
export function useBasemapStyle(): StyleSpecification | null {
  const id = useBasemapId();
  const [style, setStyle] = useState<StyleSpecification | null>(null);
  useEffect(() => {
    let cancelled = false;
    getBasemapStyle(id).then((s) => {
      if (!cancelled) setStyle(s);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return style;
}

// ── Leaflet ─────────────────────────────────────────────────────────────────

async function createLeafletLayer(L: typeof Leaflet, id: BasemapId): Promise<Leaflet.Layer> {
  const style = await getBasemapStyle(id);
  if (style !== OSM_STYLE) {
    await import("maplibre-gl/dist/maplibre-gl.css");
    const { maplibreGL } = await import("@maplibre/maplibre-gl-leaflet");
    return maplibreGL({ style });
  }
  return L.tileLayer(OSM_TILE_URL, { attribution: "© OpenStreetMap", maxZoom: 19 });
}

/**
 * Ajoute le fond de carte à une carte Leaflet et le remplace à chaque
 * changement de choix. Couche MapLibre (tuiles vectorielles) pour les fonds
 * locaux, tuiles raster OSM sinon. L'abonnement se retire seul quand la carte
 * est démontée.
 */
export function attachLeafletBasemap(L: typeof Leaflet, map: Leaflet.Map): void {
  const alive = () => map.getContainer()?.isConnected === true;
  let layer: Leaflet.Layer | null = null;
  let token = 0;

  const apply = async () => {
    const mine = ++token;
    const next = await createLeafletLayer(L, getBasemapId());
    // Choix changé entre-temps, ou carte démontée : on abandonne cette couche.
    if (mine !== token || !alive()) return;
    if (layer) map.removeLayer(layer);
    layer = next.addTo(map);
  };

  const unsubscribe = subscribe(() => {
    if (!alive()) {
      unsubscribe();
      return;
    }
    void apply();
  });
  void apply();
}
