import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as turf from "@turf/turf";
import {
  getSectionsByIds,
  updateSectionGeometry,
  deleteSection,
  refreshOverlaps,
} from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

/** Concatène les anneaux en MultiPolygon — repli si `turf.union` échoue
 * (même stratégie que la dissolution de build-sections : aucun fragment perdu). */
function concatAsMultiPolygon(geoms: PolyGeom[]): GeoJSON.MultiPolygon {
  const coordinates: GeoJSON.Position[][][] = [];
  for (const g of geoms) {
    if (g.type === "Polygon") coordinates.push(g.coordinates);
    else coordinates.push(...g.coordinates);
  }
  return { type: "MultiPolygon", coordinates };
}

/**
 * POST /api/cadastre/sections/merge — fusion manuelle de 2+ sections choisies
 * librement (pas besoin d'un chevauchement détecté : fragments d'une même
 * section, section scindée à tort, zones voisines à regrouper).
 *
 * `{ sectionIds: number[] }` dans l'ordre de sélection : la PREMIÈRE conserve
 * ses attributs (numéro, commune, lot), les autres sont supprimées. Géométrie =
 * `turf.union` de l'ensemble (MultiPolygon si disjointes), repli concaténation
 * d'anneaux si l'union échoue. Les chevauchements des lots touchés sont
 * re-contrôlés.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

  let body: { sectionIds?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const ids = Array.isArray(body.sectionIds)
    ? Array.from(new Set(body.sectionIds.map(Number).filter(Number.isInteger)))
    : [];
  if (ids.length < 2) {
    return NextResponse.json({ error: "Au moins 2 sectionIds valides requis" }, { status: 400 });
  }

  try {
    const rows = await getSectionsByIds(ids);
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      return NextResponse.json({ error: `Section(s) introuvable(s) : ${missing.join(", ")}` }, { status: 404 });
    }

    const geoms = rows.map((r) => r.geomGeoJson);
    let merged: PolyGeom;
    try {
      const u = turf.union(turf.featureCollection(geoms.map((g) => turf.feature(g))));
      merged = (u?.geometry as PolyGeom | undefined) ?? concatAsMultiPolygon(geoms);
    } catch {
      merged = concatAsMultiPolygon(geoms);
    }

    const kept = rows[0];
    await updateSectionGeometry(kept.id, merged, areaM2(merged));
    for (const r of rows.slice(1)) await deleteSection(r.id);

    // Re-contrôle des chevauchements de chaque lot touché (la fusion peut
    // couvrir plusieurs lots en vue « tous les lots »).
    const lots = Array.from(new Set(rows.map((r) => r.sourceFichier)));
    for (const src of lots) await refreshOverlaps(src);

    return NextResponse.json({ success: true, keptId: kept.id, deleted: ids.length - 1 });
  } catch (err) {
    console.error("[cadastre/sections/merge] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
