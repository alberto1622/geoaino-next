import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSection } from "@/lib/cadastre/sections-data";
import { fillMissingNicadForSection } from "@/lib/cadastre/nicad-fill-missing";
import { recordHistory } from "@/lib/cadastre/history";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/nicad-fill — attribue un NICAD aux parcelles
 * d'une section numérotée qui n'en ont AUCUN, par incrémentation depuis le
 * dernier numéro de parcelle connu dans la section, en chaînant vers la plus
 * proche (cf. `nicad-fill-missing.ts`, docs/CONCEPTS-TRAITEMENT-DXF.md
 * §11 quinquies).
 *
 * `dryRun: true` calcule le plan (nombre de parcelles, plage de numéros) SANS
 * écrire en base — sert d'aperçu avant confirmation côté client, et n'écrit
 * donc aucune entrée d'historique.
 *
 * Hors `dryRun`, capture un snapshot par `Analysis` effectivement modifiée
 * (GeoJSON avant écriture + erreurs résolues + stats agrégées avant patch) et
 * l'enregistre comme UNE entrée d'historique restaurable couvrant tout
 * l'appel, dans la même transaction que les écritures — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

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
    const numSection = section.numSection;
    const dryRun = body.dryRun === true;

    if (dryRun) {
      const { result } = await fillMissingNicadForSection(section, numSection, { dryRun: true });
      return NextResponse.json({ success: true, sectionId, dryRun: true, result });
    }

    const { result } = await prisma.$transaction(
      async (tx) => {
        const out = await fillMissingNicadForSection(section, numSection, { dryRun: false }, tx);
        if (out.snapshot.analyses.length > 0) {
          await recordHistory(tx, {
            scope: "sections",
            scopeKey: section.syscolCommune,
            action: "nicad-fill",
            summary: `Attribution NICAD sur la section ${numSection}${section.commune ? ` (${section.commune})` : ""} — ${out.result.parcelsAssigned} parcelle(s)`,
            before: out.snapshot,
            after: {},
            createdBy,
          });
        }
        return out;
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    return NextResponse.json({ success: true, sectionId, dryRun: false, result });
  } catch (err) {
    console.error("[cadastre/sections/nicad-fill] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
