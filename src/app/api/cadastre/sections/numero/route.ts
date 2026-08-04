import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getSection,
  findSectionNumeroConflict,
  updateSectionNumero,
} from "@/lib/cadastre/sections-data";
import { normalizeSection } from "@/lib/nicad";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/numero — attribue un numéro à une section qui
 * n'en a pas encore (numSection NULL : libellé absent ou hors polygone lors
 * de l'extraction, cf. docs/CONCEPTS-TRAITEMENT-DXF.md §11). Refuse si la
 * section a déjà un numéro, ou si une autre section de la même commune
 * (syscolCommune) porte déjà ce numéro — le numéro de section n'est unique
 * QUE dans sa commune (cf. build-sections.ts).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

  let body: { sectionId?: number; numSection?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const sectionId = Number(body.sectionId);
  const numSection = normalizeSection(body.numSection);
  if (!Number.isInteger(sectionId) || !numSection) {
    return NextResponse.json({ error: "sectionId et numSection requis (numérique)" }, { status: 400 });
  }

  try {
    const existing = await getSection(sectionId);
    if (!existing) {
      return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
    }
    if (existing.numSection) {
      return NextResponse.json({ error: "Cette section a déjà un numéro" }, { status: 409 });
    }

    const conflict = await findSectionNumeroConflict(existing.syscolCommune, numSection, sectionId);
    if (conflict) {
      return NextResponse.json(
        {
          error: `Le numéro ${numSection} est déjà utilisé par la section #${conflict.id}${
            conflict.commune ? ` (${conflict.commune})` : ""
          } — fusionnez-les si c'est la même section.`,
        },
        { status: 409 },
      );
    }

    await updateSectionNumero(sectionId, numSection);
    return NextResponse.json({ success: true, sectionId, numSection });
  } catch (err) {
    console.error("[cadastre/sections/numero] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
