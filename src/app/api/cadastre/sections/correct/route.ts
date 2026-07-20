import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as turf from "@turf/turf";
import {
  getOverlap,
  getSection,
  updateSectionGeometry,
  deleteSection,
  setOverlapStatus,
  refreshOverlaps,
  listSections,
  listOverlaps,
} from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;
type Action = "clip_a" | "clip_b" | "merge" | "delete_a" | "delete_b" | "ignore";
const ACTIONS = new Set<Action>(["clip_a", "clip_b", "merge", "delete_a", "delete_b", "ignore"]);

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

/**
 * POST /api/cadastre/sections/correct — résout un chevauchement entre deux
 * sections. Actions (mirroir des OVERLAP parcelles) :
 *  - `clip_a` / `clip_b` : retire l'intersection de la section A (ou B) —
 *    `turf.difference` ; si la cible est entièrement couverte, elle est supprimée ;
 *  - `merge` : fusionne A et B (`turf.union`), B supprimée ;
 *  - `delete_a` / `delete_b` : supprime la section choisie ;
 *  - `ignore` : marque le chevauchement intentionnel (IGNORED).
 * Renvoie les sections + chevauchements à jour (re-contrôle après géométrie).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

  let body: { overlapId?: number; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const overlapId = Number(body.overlapId);
  const action = body.action as Action;
  if (!Number.isInteger(overlapId) || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "overlapId et action valides requis" }, { status: 400 });
  }

  const ov = await getOverlap(overlapId);
  if (!ov) return NextResponse.json({ error: "Chevauchement introuvable" }, { status: 404 });
  const src = ov.sourceFichier;

  try {
    if (action === "ignore") {
      await setOverlapStatus(overlapId, "IGNORED");
    } else {
      const [a, b] = await Promise.all([getSection(ov.sectionAId), getSection(ov.sectionBId)]);
      if (!a || !b) return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
      const fa = turf.feature(a.geomGeoJson);
      const fb = turf.feature(b.geomGeoJson);

      if (action === "clip_a" || action === "clip_b") {
        const targetId = action === "clip_a" ? ov.sectionAId : ov.sectionBId;
        const [tf, of] = action === "clip_a" ? [fa, fb] : [fb, fa];
        const diff = turf.difference(turf.featureCollection([tf, of]));
        if (!diff || !diff.geometry) {
          await deleteSection(targetId); // cible entièrement couverte
        } else {
          const g = diff.geometry as PolyGeom;
          await updateSectionGeometry(targetId, g, areaM2(g));
        }
      } else if (action === "merge") {
        const u = turf.union(turf.featureCollection([fa, fb]));
        if (!u || !u.geometry) {
          return NextResponse.json({ error: "Fusion impossible" }, { status: 400 });
        }
        const g = u.geometry as PolyGeom;
        await updateSectionGeometry(ov.sectionAId, g, areaM2(g));
        await deleteSection(ov.sectionBId);
      } else if (action === "delete_a") {
        await deleteSection(ov.sectionAId);
      } else if (action === "delete_b") {
        await deleteSection(ov.sectionBId);
      }

      // Re-contrôle des chevauchements après modification géométrique.
      await refreshOverlaps(src);
    }

    const [sections, overlaps] = await Promise.all([listSections(src), listOverlaps(src)]);
    return NextResponse.json({ success: true, sections, overlaps });
  } catch (err) {
    console.error("[cadastre/sections/correct] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
