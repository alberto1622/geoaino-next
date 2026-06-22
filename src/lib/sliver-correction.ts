import * as turf from "@turf/turf";
import type { Feature, Polygon, MultiPolygon, LineString, MultiLineString } from "geojson";
import { detectSliver, extractNicad, type GeoFeature } from "./geo-engine";

// ── Correction des parcelles résiduelles (slivers) ───────────────────────────
//
// Principe (équivalent à l'outil QGIS « Éliminer les polygones résiduels ») :
// une parcelle résiduelle est rattachée à la parcelle adjacente appropriée,
// c'est-à-dire celle avec laquelle elle partage la plus longue frontière commune.
// La géométrie du sliver est fusionnée (union) dans ce voisin, puis le sliver
// est retiré du jeu de données.
//
// Toute l'analyse géométrique (adjacence, longueur de frontière, surface) est
// réalisée en WGS84 (degrés lon/lat) afin que les mesures métriques de Turf
// soient correctes — y compris pour les fichiers en UTM 28N, reprojetés à la
// volée via proj4 (même convention que `geo-engine.ts`). En revanche, l'union
// finale est calculée dans les coordonnées d'ORIGINE pour que le GeoJSON
// corrigé reste dans le système de référence du fichier source.

type TurfPoly = Feature<Polygon | MultiPolygon>;
type TurfLine = Feature<LineString | MultiLineString>;

const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

// Tolérance de superposition de lignes : 5 m (lineOverlap attend des km).
const OVERLAP_TOLERANCE_KM = 0.005;

export interface NeighborMatch {
  /** Index du voisin retenu dans le tableau de features. */
  neighborIdx: number;
  /** Longueur (m) de la frontière commune (0 si retenu par intersection seule). */
  sharedLengthM: number;
  /** true si retenu par plus grande surface (pas d'arête commune détectée). */
  byOverlap: boolean;
}

function firstRing(f: GeoFeature): number[][] | null {
  try {
    const g = f.geometry;
    if (g?.type === "Polygon") return (g.coordinates as number[][][])[0] ?? null;
    if (g?.type === "MultiPolygon") return ((g.coordinates as number[][][][])[0])?.[0] ?? null;
    return null;
  } catch {
    return null;
  }
}

function bboxOverlap(
  a: [number, number, number, number] | null,
  b: [number, number, number, number] | null
): boolean {
  if (!a || !b) return false;
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// Contexte d'analyse : représentations WGS84, bboxes et flags partagés par les
// deux points d'entrée (correction en lot et correction d'une erreur unique).
interface Ctx {
  work: GeoFeature[];
  wgs: (TurfPoly | null)[];
  bboxes: ([number, number, number, number] | null)[];
  isSliver: boolean[];
  removed: boolean[];
  toWgs84: (f: GeoFeature) => TurfPoly | null;
}

function buildContext(features: GeoFeature[]): Ctx {
  // Détection du CRS à partir de la première parcelle polygonale rencontrée.
  let coordsAreUtm = false;
  for (const f of features) {
    const ring = firstRing(f);
    if (ring && ring[0]) {
      coordsAreUtm = Math.abs(ring[0][0]) > 180;
      break;
    }
  }

  let proj4: typeof import("proj4") | null = null;
  if (coordsAreUtm) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      proj4 = require("proj4");
    } catch {
      proj4 = null;
    }
  }

  const toWgs84 = (f: GeoFeature): TurfPoly | null => {
    try {
      const type = f.geometry?.type;
      if (type !== "Polygon" && type !== "MultiPolygon") return null;
      if (!coordsAreUtm || !proj4) return f as unknown as TurfPoly;

      const reprojectRing = (ring: number[][]): number[][] =>
        ring.map((pt) => proj4!(UTM28N, WGS84, [pt[0], pt[1]]));

      let geom: { type: string; coordinates: unknown };
      if (type === "Polygon") {
        geom = { type: "Polygon", coordinates: (f.geometry.coordinates as number[][][]).map(reprojectRing) };
      } else {
        geom = {
          type: "MultiPolygon",
          coordinates: (f.geometry.coordinates as number[][][][]).map((p) => p.map(reprojectRing)),
        };
      }
      return { type: "Feature", properties: f.properties ?? {}, geometry: geom } as unknown as TurfPoly;
    } catch {
      return null;
    }
  };

  // Clones de travail : on remplacera la géométrie des voisins absorbant un sliver
  // sans muter les features d'entrée.
  const work: GeoFeature[] = features.map((f) => ({ ...f }));
  const wgs = work.map(toWgs84);
  const bboxes = wgs.map((f) => {
    try {
      return f ? (turf.bbox(f) as [number, number, number, number]) : null;
    } catch {
      return null;
    }
  });
  const isSliver = work.map((f) => detectSliver(f).isSliver);
  const removed: boolean[] = new Array(work.length).fill(false);

  return { work, wgs, bboxes, isSliver, removed, toWgs84 };
}

/**
 * Sélectionne, pour le sliver `s`, la parcelle adjacente appropriée :
 *  - priorité 1 : voisin partageant la plus longue frontière commune ;
 *  - priorité 2 (aucune arête commune détectée) : voisin qui touche réellement
 *    le sliver, départagé par sa surface.
 * Retourne `null` si aucun voisin adjacent n'est trouvé.
 */
function selectBestNeighbor(ctx: Ctx, s: number): NeighborMatch | null {
  const { work, wgs, bboxes, isSliver, removed } = ctx;
  const sliverWgs = wgs[s];
  const sliverBbox = bboxes[s];
  if (!sliverWgs || !sliverBbox) return null;

  let sliverLine: TurfLine;
  try {
    sliverLine = turf.polygonToLine(sliverWgs) as TurfLine;
  } catch {
    return null;
  }

  let best = -1;
  let bestSharedLen = 0;
  let bestArea = 0;
  let bestByOverlap = false;

  for (let n = 0; n < work.length; n++) {
    if (n === s || removed[n] || isSliver[n]) continue;
    if (!bboxOverlap(sliverBbox, bboxes[n])) continue;

    const neighborWgs = wgs[n];
    if (!neighborWgs) continue;

    let sharedLen = 0;
    try {
      const neighborLine = turf.polygonToLine(neighborWgs) as TurfLine;
      const shared = turf.lineOverlap(sliverLine, neighborLine, { tolerance: OVERLAP_TOLERANCE_KM });
      if (shared && shared.features.length > 0) {
        sharedLen = turf.length(shared, { units: "meters" });
      }
    } catch {
      sharedLen = 0;
    }

    if (sharedLen > 0) {
      if (sharedLen > bestSharedLen) {
        best = n;
        bestSharedLen = sharedLen;
        bestByOverlap = false;
      }
      continue;
    }

    // Pas d'arête commune détectée : ne retenir que les voisins qui touchent
    // réellement le sliver, départagés par leur surface — et seulement si
    // aucune frontière commune n'a déjà été trouvée ailleurs.
    if (bestSharedLen > 0) continue;
    try {
      if (!turf.booleanIntersects(sliverWgs, neighborWgs)) continue;
      const area = turf.area(neighborWgs);
      if (area > bestArea) {
        best = n;
        bestArea = area;
        bestByOverlap = true;
      }
    } catch {
      /* ignore */
    }
  }

  if (best < 0) return null;
  return { neighborIdx: best, sharedLengthM: bestSharedLen, byOverlap: bestByOverlap };
}

export interface SingleSliverMerge {
  neighborIdx: number;
  neighborNicad: string;
  mergedGeometry: GeoFeature["geometry"];
  sharedLengthM: number;
  byOverlap: boolean;
}

/**
 * Détermine la parcelle adjacente appropriée pour un sliver donné (par index)
 * et calcule la géométrie fusionnée, dans les coordonnées d'ORIGINE.
 * Utilisé par la correction d'une erreur unique depuis l'interface.
 * Ne mute pas `features` ; retourne `null` si aucun voisin adjacent.
 */
export function findBestNeighborMerge(features: GeoFeature[], sliverIdx: number): SingleSliverMerge | null {
  if (sliverIdx < 0 || sliverIdx >= features.length) return null;
  const ctx = buildContext(features);
  const match = selectBestNeighbor(ctx, sliverIdx);
  if (!match) return null;

  try {
    const merged = turf.union(
      turf.featureCollection([
        features[match.neighborIdx] as unknown as TurfPoly,
        features[sliverIdx] as unknown as TurfPoly,
      ])
    );
    if (!merged) return null;
    const neighborNicad = extractNicad(features[match.neighborIdx].properties) || `feature_${match.neighborIdx}`;
    return {
      neighborIdx: match.neighborIdx,
      neighborNicad,
      mergedGeometry: merged.geometry as GeoFeature["geometry"],
      sharedLengthM: match.sharedLengthM,
      byOverlap: match.byOverlap,
    };
  } catch {
    return null;
  }
}
