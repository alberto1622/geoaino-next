import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { bornesDuReferentiel } from "@/lib/cadastre/verif/referentiel";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/verif/referentiel?nicad=... — reprend les bornes d'une
 * parcelle connue depuis `CadParcelle` (commodité de saisie ; ne lit aucun
 * document — cf. src/lib/cadastre/verif/referentiel.ts).
 *
 * Réponse : `{ bornes, superficieDeclaree?, syscolCommune, numSection,
 * numParcelle }` ou 404 si le NICAD est introuvable / sans géométrie.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const nicad = req.nextUrl.searchParams.get("nicad")?.trim();
  if (!nicad) {
    return NextResponse.json({ error: "Paramètre « nicad » requis." }, { status: 400 });
  }

  try {
    const trouve = await bornesDuReferentiel(nicad);
    if (!trouve) {
      return NextResponse.json(
        {
          error:
            "NICAD introuvable dans le référentiel, ou parcelle sans géométrie exploitable.",
        },
        { status: 404 },
      );
    }
    return NextResponse.json(trouve);
  } catch (e) {
    console.error("Erreur recherche référentiel verif :", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Erreur : ${message}` }, { status: 500 });
  }
}
