/**
 * admin-boundaries.ts — limites administratives (régions, départements,
 * communes) pour l'affichage carte.
 *
 * Seules les communes (`cad_communes_2026`) portent une géométrie ; les
 * départements et régions sont DISSOUS à la volée (`ST_Union` groupé par
 * attribut) puis simplifiés (`ST_SimplifyPreserveTopology`) — les contours
 * servent au repérage visuel, pas aux jointures (qui restent sur les communes
 * pleines). Résultat mis en cache en mémoire : le référentiel est statique.
 */
import { prisma } from "@/lib/prisma";

export type AdminLevel = "regions" | "departements" | "communes";

export interface AdminBoundaries {
  boundaries: GeoJSON.FeatureCollection;
  labels: Array<{ lng: number; lat: number; nom: string }>;
}

// Tolérances de simplification (degrés ≈ 111 km/°) : assez fines pour suivre
// les contours à l'échelle d'usage, assez grossières pour un payload léger.
const SIMPLIFY_TOLERANCE: Record<AdminLevel, number> = {
  communes: 0.0003, // ~33 m
  departements: 0.0006, // ~66 m
  regions: 0.001, // ~110 m
};

const CACHE = new Map<AdminLevel, AdminBoundaries>();

interface Row {
  nom: string | null;
  geom: GeoJSON.Geometry | null;
  pt: GeoJSON.Point | null;
}

export async function getAdminBoundaries(niveau: AdminLevel): Promise<AdminBoundaries> {
  const hit = CACHE.get(niveau);
  if (hit) return hit;

  const tol = SIMPLIFY_TOLERANCE[niveau];
  let rows: Row[];
  if (niveau === "communes") {
    rows = await prisma.$queryRaw<Row[]>`
      SELECT "nomCommune" AS nom,
             ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, ${tol}))::jsonb AS geom,
             ST_AsGeoJSON(ST_PointOnSurface(geom))::jsonb AS pt
      FROM "cad_communes_2026"
      WHERE geom IS NOT NULL
      ORDER BY "nomCommune"
    `;
  } else if (niveau === "departements") {
    rows = await prisma.$queryRaw<Row[]>`
      SELECT "departement" AS nom,
             ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Union(geom), ${tol}))::jsonb AS geom,
             ST_AsGeoJSON(ST_PointOnSurface(ST_Union(geom)))::jsonb AS pt
      FROM "cad_communes_2026"
      WHERE geom IS NOT NULL AND "departement" IS NOT NULL
      GROUP BY "departement"
      ORDER BY "departement"
    `;
  } else {
    rows = await prisma.$queryRaw<Row[]>`
      SELECT "region" AS nom,
             ST_AsGeoJSON(ST_SimplifyPreserveTopology(ST_Union(geom), ${tol}))::jsonb AS geom,
             ST_AsGeoJSON(ST_PointOnSurface(ST_Union(geom)))::jsonb AS pt
      FROM "cad_communes_2026"
      WHERE geom IS NOT NULL AND "region" IS NOT NULL
      GROUP BY "region"
      ORDER BY "region"
    `;
  }

  const result: AdminBoundaries = {
    boundaries: {
      type: "FeatureCollection",
      features: rows
        .filter((r) => r.geom)
        .map((r) => ({
          type: "Feature" as const,
          geometry: r.geom as GeoJSON.Geometry,
          properties: { nom: r.nom },
        })),
    },
    labels: rows
      .filter((r) => r.pt && Array.isArray(r.pt.coordinates) && r.nom)
      .map((r) => ({ lng: r.pt!.coordinates[0], lat: r.pt!.coordinates[1], nom: r.nom! })),
  };

  CACHE.set(niveau, result);
  return result;
}
