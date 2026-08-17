import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import * as turf from "@turf/turf";
import {
  getSectionsFullByIds,
  getOverlapsForSections,
  updateSectionGeometry,
  deleteSection,
  refreshOverlaps,
} from "@/lib/cadastre/sections-data";
import { getAdminMismatchesForSections, refreshAdminMismatches } from "@/lib/cadastre/admin-mismatch-data";
import { recordHistory, type SectionsDeleteSnapshot } from "@/lib/cadastre/history";

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

type MergeOutcome =
  | { kind: "not-found"; missing: number[] }
  | { kind: "ok"; keptId: number; keptNumSection: string | null; keptCommune: string | null; lots: string[] };

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
 *
 * Capture un snapshot complet des N sections (y compris la géométrie
 * D'ORIGINE de la section conservée, avant fusion) et de leurs chevauchements,
 * AVANT toute mutation, dans la même transaction — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

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
    const outcome = await prisma.$transaction(
      async (tx): Promise<MergeOutcome> => {
        const rows = await getSectionsFullByIds(ids, tx);
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((r) => r.id));
          return { kind: "not-found", missing: ids.filter((id) => !found.has(id)) };
        }
        const overlaps = await getOverlapsForSections(ids, tx);
        const adminMismatches = await getAdminMismatchesForSections(ids, tx);
        const before: SectionsDeleteSnapshot = { sections: rows, overlaps, adminMismatches };

        const geoms = rows.map((r) => r.geomGeoJson);
        let merged: PolyGeom;
        try {
          const u = turf.union(turf.featureCollection(geoms.map((g) => turf.feature(g))));
          merged = (u?.geometry as PolyGeom | undefined) ?? concatAsMultiPolygon(geoms);
        } catch {
          merged = concatAsMultiPolygon(geoms);
        }

        const kept = rows[0];
        await updateSectionGeometry(kept.id, merged, areaM2(merged), tx);
        for (const r of rows.slice(1)) await deleteSection(r.id, tx);

        await recordHistory(tx, {
          scope: "sections",
          scopeKey: kept.syscolCommune,
          action: "merge",
          summary: `Fusion de ${rows.length} sections en ${kept.numSection ?? "#" + kept.id}${kept.commune ? ` (${kept.commune})` : ""}`,
          before,
          after: {},
          createdBy,
        });

        return {
          kind: "ok",
          keptId: kept.id,
          keptNumSection: kept.numSection,
          keptCommune: kept.commune,
          lots: Array.from(new Set(rows.map((r) => r.sourceFichier))),
        };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: `Section(s) introuvable(s) : ${outcome.missing.join(", ")}` }, { status: 404 });
    }

    for (const src of outcome.lots) {
      await refreshOverlaps(src);
      await refreshAdminMismatches(src);
    }

    return NextResponse.json({ success: true, keptId: outcome.keptId, deleted: ids.length - 1 });
  } catch (err) {
    console.error("[cadastre/sections/merge] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
