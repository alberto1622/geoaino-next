import * as turf from "@turf/turf";
import { extractNicad } from "@/lib/geo-engine";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type GeoFeature = { type: "Feature"; geometry: any; properties: Record<string, unknown> | null };
export type BBox = [number, number, number, number];

/**
 * Localisateur d'une parcelle, du plus précis au moins précis :
 *  - `point` [lng, lat] : coordonnée intérieure (clic carte) → point-dans-polygone ;
 *  - `bbox` [w, s, e, n] : emprise (occurrence d'un groupe NICAD) → appariement d'emprise ;
 *  - `nicad` : repli (première parcelle libre portant ce NICAD).
 *
 * Partagé par la suppression et la réassignation de NICAD : les tuiles
 * vectorielles ne portent pas d'identifiant stable, on cible donc chaque parcelle
 * par ce localisateur. `bbox` désambiguïse une occurrence précise d'un doublon
 * (même NICAD) que le repli `nicad` ne saurait distinguer.
 */
export type Locator = { point?: [number, number]; bbox?: BBox; nicad?: string };

const isPolygonal = (f?: GeoFeature): boolean =>
  f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

function featureBBox(f: GeoFeature): BBox | null {
  try {
    return turf.bbox(f as any) as BBox;
  } catch {
    return null;
  }
}

const bboxL1 = (a: BBox, b: BBox): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);

/** Résout un localisateur en index de feature dans le GeoJSON, ou -1. */
export function resolveLocator(features: GeoFeature[], loc: Locator, taken: Set<number>): number {
  // 1. Point intérieur (le plus fiable) : parcelle contenant le point.
  if (loc.point && Number.isFinite(loc.point[0]) && Number.isFinite(loc.point[1])) {
    const pt = turf.point(loc.point);
    for (let i = 0; i < features.length; i++) {
      if (taken.has(i) || !isPolygonal(features[i])) continue;
      try {
        if (turf.booleanPointInPolygon(pt, features[i] as any)) return i;
      } catch {
        /* géométrie non testable : ignorer */
      }
    }
  }

  // 2. Emprise (occurrence précise d'un NICAD dupliqué).
  if (loc.bbox) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < features.length; i++) {
      if (taken.has(i)) continue;
      const b = featureBBox(features[i]);
      if (!b) continue;
      const d = bboxL1(b, loc.bbox);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD < 1e-5) return best;
  }

  // 3. NICAD (repli, première occurrence libre).
  if (loc.nicad) {
    for (let i = 0; i < features.length; i++) {
      if (taken.has(i)) continue;
      if (extractNicad(features[i].properties) === loc.nicad) return i;
    }
  }

  return -1;
}

// Clés de propriété reconnues par `extractNicad` (ordre = priorité de lecture).
export const NICAD_KEYS = [
  "nicad", "NICAD", "Nicad", "NIC",
  "NUM_NICAD", "num_nicad", "CODE_NICAD", "code_nicad", "CODIF", "codif",
] as const;

/**
 * Réécrit le NICAD d'une feature sur TOUTES ses clés porteuses (+ `nicad`), pour
 * que l'extraction (index de tuiles) et l'affichage (table) restent cohérents.
 */
export function setFeatureNicad(feature: GeoFeature, nicad: string): void {
  const props = { ...(feature.properties ?? {}) };
  for (const k of NICAD_KEYS) if (k in props) props[k] = nicad;
  props.nicad = nicad;
  feature.properties = props;
}

// Clés de propriété reconnues pour le numéro de section (cf. `tile-index.ts ·
// _ssec` et `MapLibreMap.tsx`, popup) — distinctes des clés NICAD : le numéro
// de section est une propriété à part sur la feature, pas seulement le
// segment médian du NICAD.
export const SECTION_KEYS = ["numero_section", "num_section", "NUM_SECTION"] as const;

/**
 * Réécrit le numéro de section d'une feature sur TOUTES ses clés porteuses (+
 * `numero_section`, clé canonique écrite à l'ingestion). Sans cette réécriture,
 * la classification « sans section » (`_ssec`, tile-index.ts) reste périmée
 * après un NICAD reconstruit : cette propriété est indépendante du NICAD, la
 * corriger dans le NICAD ne la met pas à jour.
 */
export function setFeatureSection(feature: GeoFeature, numSection: string): void {
  const props = { ...(feature.properties ?? {}) };
  for (const k of SECTION_KEYS) if (k in props) props[k] = numSection;
  props.numero_section = numSection;
  feature.properties = props;
}
