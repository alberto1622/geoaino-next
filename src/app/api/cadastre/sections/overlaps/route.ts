import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listSections, listOverlaps } from "@/lib/cadastre/sections-data";
import { publicErrorMessage } from "@/lib/api-errors";
import { roundGeometry } from "@/lib/geojson-precision";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/sections/overlaps[?sourceFichier=...] — sections +
 * chevauchements détectés (géométries incluses) pour le rendu et la liste de
 * corrections de la page /cadastre/sections. `sourceFichier` peut être répété
 * (sélection multiple du filtre "Lot stocké") ; sans lui, renvoie les
 * sections de TOUS les lots stockés (affichage complet au premier chargement).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const sourceFichierList = req.nextUrl.searchParams.getAll("sourceFichier");
  const sourceFichier = sourceFichierList.length > 0 ? sourceFichierList : null;
  try {
    const [sections, overlaps] = await Promise.all([
      listSections(sourceFichier),
      listOverlaps(sourceFichier),
    ]);
    // Coordonnées arrondies à ~1 cm : réponse d'affichage uniquement (cf.
    // geojson-precision.ts), ~31 % de JSON en moins sur les gros lots.
    return NextResponse.json({
      sourceFichier,
      sections: sections.map((s) => ({ ...s, geomGeoJson: roundGeometry(s.geomGeoJson) })),
      overlaps: overlaps.map((o) => ({ ...o, intersectionGeoJson: roundGeometry(o.intersectionGeoJson) })),
    });
  } catch (err) {
    console.error("[cadastre/sections/overlaps] GET", err);
    return NextResponse.json({ error: publicErrorMessage(err) }, { status: 500 });
  }
}
