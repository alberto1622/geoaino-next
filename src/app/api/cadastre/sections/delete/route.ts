import { NextRequest, NextResponse } from "next/server";
import {
  deleteSection,
  deleteSectionsBySource,
  getSection,
} from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/delete — supprime des lignes `limite_section` :
 *  - `{ sourceFichier }` : tout le lot d'un fichier chargé (sections +
 *    chevauchements associés) ;
 *  - `{ sectionId }` : une seule section (ses chevauchements référencés sont
 *    retirés par `deleteSection` ; en supprimer une ne peut pas en créer).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { sourceFichier?: string; sectionId?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }

  const sectionId = body.sectionId != null ? Number(body.sectionId) : null;
  const sourceFichier = typeof body.sourceFichier === "string" ? body.sourceFichier.trim() : "";

  try {
    if (sectionId != null) {
      if (!Number.isInteger(sectionId)) {
        return NextResponse.json({ error: "sectionId invalide" }, { status: 400 });
      }
      const existing = await getSection(sectionId);
      if (!existing) {
        return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
      }
      await deleteSection(sectionId);
      return NextResponse.json({ success: true, deleted: 1 });
    }

    if (sourceFichier) {
      await deleteSectionsBySource(sourceFichier);
      return NextResponse.json({ success: true, sourceFichier });
    }

    return NextResponse.json({ error: "sectionId ou sourceFichier requis" }, { status: 400 });
  } catch (err) {
    console.error("[cadastre/sections/delete] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
