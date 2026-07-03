import { NextRequest } from "next/server";
import { getTileEntry } from "@/lib/analyses/tile-index";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * GET /api/analyses/[id]/map-meta — métadonnées carto pour le rendu par tuiles.
 *
 *  - sans paramètre : `{ bbox: [w,s,e,n] | null, count }` (fit initial de la carte) ;
 *  - `?nicad=XXX` : `{ bounds: [w,s,e,n] | null }` (fit sur une parcelle précise,
 *    sans embarquer sa géométrie côté client).
 *
 * S'appuie sur l'index de tuiles mis en cache (`tile-index.ts`).
 */
export async function GET(req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return Response.json({ error: "ID invalide" }, { status: 400 });
  }

  const entry = await getTileEntry(analysisId);
  if (!entry) return Response.json({ error: "Analyse introuvable" }, { status: 404 });

  const nicad = req.nextUrl.searchParams.get("nicad");
  if (nicad) {
    return Response.json({ bounds: entry.nicadBounds.get(nicad) ?? null });
  }

  return Response.json({ bbox: entry.bbox, count: entry.count });
}
