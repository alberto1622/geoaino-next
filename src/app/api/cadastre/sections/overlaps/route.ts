import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listSections, listOverlaps } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/sections/overlaps[?sourceFichier=...] — sections +
 * chevauchements détectés (géométries incluses) pour le rendu et la liste de
 * corrections de la page /cadastre/sections. Sans `sourceFichier`, renvoie les
 * sections de TOUS les lots stockés (affichage complet au premier chargement).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const sourceFichier = req.nextUrl.searchParams.get("sourceFichier");
  try {
    const [sections, overlaps] = await Promise.all([
      listSections(sourceFichier),
      listOverlaps(sourceFichier),
    ]);
    return NextResponse.json({ sourceFichier, sections, overlaps });
  } catch (err) {
    console.error("[cadastre/sections/overlaps] GET", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
