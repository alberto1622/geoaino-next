import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/analyses/require-session";
import { fillMissingNicadForAnalysis } from "@/lib/cadastre/nicad-fill-missing";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * POST /api/analyses/[id]/nicad-fill — attribue un NICAD aux parcelles de
 * CETTE analyse qui n'en ont AUCUN, par incrémentation depuis le dernier
 * numéro de parcelle connu dans chacune de ses sections numérotées, en
 * chaînant vers la plus proche (cf. `nicad-fill-missing.ts ·
 * fillMissingNicadForAnalysis`, docs/CONCEPTS-TRAITEMENT-DXF.md §11 quinquies).
 *
 * `dryRun: true` calcule le plan (par section : nombre de parcelles, plage de
 * numéros) SANS écrire en base — sert d'aperçu avant confirmation côté client.
 * `sections: string[]` restreint le traitement à un sous-ensemble des numéros
 * de section renvoyés par un aperçu précédent (sélection utilisateur) ;
 * omis, TOUTES les sections numérotées de l'analyse sont traitées.
 */
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const analysisId = parseInt(id);
  if (!Number.isInteger(analysisId)) {
    return NextResponse.json({ error: "Identifiant d'analyse invalide" }, { status: 400 });
  }

  let body: { dryRun?: boolean; sections?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const sections = Array.isArray(body.sections)
    ? body.sections.filter((s): s is string => typeof s === "string")
    : undefined;

  try {
    const result = await fillMissingNicadForAnalysis(analysisId, {
      dryRun: body.dryRun === true,
      sections,
    });
    return NextResponse.json({ success: true, analysisId, dryRun: body.dryRun === true, result });
  } catch (err) {
    console.error("[analyses/nicad-fill] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
