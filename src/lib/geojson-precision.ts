/**
 * geojson-precision.ts — arrondi des coordonnées GeoJSON pour l'AFFICHAGE.
 *
 * Les géométries stockées portent ~15 décimales (précision nanométrique,
 * artefact des calculs PostGIS/turf). Pour une réponse destinée à une carte,
 * 7 décimales en degrés ≈ 1,1 cm au sol : invisible à l'écran, et ~31 % de
 * JSON en moins sur /cadastre/sections (6,4 → 4,4 Mo pour 4 547 sections).
 *
 * À n'utiliser QUE sur des réponses d'affichage : les géométries en base et
 * les calculs serveur (fusion, découpe, export) gardent leur pleine précision.
 */

const DEFAULT_DECIMALS = 7;

function roundNested(value: unknown, factor: number): unknown {
  if (typeof value === "number") return Math.round(value * factor) / factor;
  if (Array.isArray(value)) return value.map((v) => roundNested(v, factor));
  return value;
}

/** Copie de la géométrie avec des coordonnées arrondies (`null`/non-géométrie : renvoyé tel quel). */
export function roundGeometry<T>(geom: T, decimals = DEFAULT_DECIMALS): T {
  const g = geom as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null;
  if (!g || typeof g !== "object") return geom;
  const factor = 10 ** decimals;
  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    return { ...g, geometries: g.geometries.map((x) => roundGeometry(x, decimals)) } as T;
  }
  if (!("coordinates" in g)) return geom;
  return { ...g, coordinates: roundNested(g.coordinates, factor) } as T;
}
