import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTileEntry, geometryBBox, type BBox } from "@/lib/analyses/tile-index";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/** Distance L1 entre deux emprises (identiques si même feature, aux arrondis près). */
function bboxDist(a: BBox, b: BBox): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
}

/**
 * GET /api/analyses/[id]/nicad-group?nicad=XXX — parcelles partageant un NICAD.
 *
 * Retourne les propriétés + emprise de chaque occurrence d'un NICAD **en doublon**
 * (`{ members: [...], count }`), pour peupler la table attributaire au clic sur une
 * parcelle dupliquée sans charger tout le GeoJSON côté client. `members` vide si le
 * NICAD n'est pas dupliqué. S'appuie sur l'index de tuiles mis en cache.
 */
export async function GET(req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return Response.json({ error: "ID invalide" }, { status: 400 });
  }

  const nicad = req.nextUrl.searchParams.get("nicad");
  if (!nicad) return Response.json({ error: "Paramètre nicad requis" }, { status: 400 });

  const entry = await getTileEntry(analysisId);
  if (!entry) return Response.json({ error: "Analyse introuvable" }, { status: 404 });

  const group = entry.nicadGroups.get(nicad) ?? [];
  // Copies (on ne mute pas le cache) enrichies de `_errorId` : chaque occurrence
  // est rattachée à SON erreur DUPLICATE (matchée par emprise), pour permettre la
  // suppression directe via l'action serveur existante.
  const members = group.map((m) => ({ ...m })) as Array<Record<string, unknown> & { _bbox: BBox; _errorId?: number }>;

  if (members.length > 0) {
    const errs = await prisma.topologicalError.findMany({
      where: { analysisId, errorType: "DUPLICATE", nicad1: nicad, corrected: false },
      select: { id: true, geometry: true },
    });
    const errBoxes = errs
      .map((e) => ({ id: e.id, bbox: geometryBBox(e.geometry as unknown as GeoJSON.Geometry) }))
      .filter((x): x is { id: number; bbox: BBox } => x.bbox !== null);

    const used = new Set<number>();
    for (const m of members) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < errBoxes.length; i++) {
        if (used.has(i)) continue;
        const d = bboxDist(m._bbox, errBoxes[i].bbox);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0 && bestD < 1e-5) {
        m._errorId = errBoxes[best].id;
        used.add(best);
      }
    }
  }

  return Response.json({ members, count: members.length });
}
