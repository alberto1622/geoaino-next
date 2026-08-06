import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSection } from "@/lib/cadastre/sections-data";
import { fillMissingNicadForSection } from "@/lib/cadastre/nicad-fill-missing";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/nicad-fill — attribue un NICAD aux parcelles
 * d'une section numérotée qui n'en ont AUCUN, par incrémentation depuis le
 * dernier numéro de parcelle connu dans la section, en chaînant vers la plus
 * proche (cf. `nicad-fill-missing.ts`, docs/CONCEPTS-TRAITEMENT-DXF.md
 * §11 quinquies).
 *
 * `dryRun: true` calcule le plan (nombre de parcelles, plage de numéros) SANS
 * écrire en base — sert d'aperçu avant confirmation côté client.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

  let body: { sectionId?: number; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const sectionId = Number(body.sectionId);
  if (!Number.isInteger(sectionId)) {
    return NextResponse.json({ error: "sectionId requis" }, { status: 400 });
  }

  try {
    const section = await getSection(sectionId);
    if (!section) {
      return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
    }
    if (!section.numSection) {
      return NextResponse.json(
        { error: "Cette section n'a pas encore de numéro — attribuez-lui-en un d'abord." },
        { status: 400 },
      );
    }

    const result = await fillMissingNicadForSection(section, section.numSection, {
      dryRun: body.dryRun === true,
    });

    return NextResponse.json({ success: true, sectionId, dryRun: body.dryRun === true, result });
  } catch (err) {
    console.error("[cadastre/sections/nicad-fill] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
