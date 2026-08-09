import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getSectionFull,
  findSectionNumeroConflict,
  updateSectionNumero,
} from "@/lib/cadastre/sections-data";
import { normalizeSection } from "@/lib/nicad";
import { syncNicadForSectionChange, type NicadSyncResult } from "@/lib/cadastre/nicad-section-sync";
import { recordHistory, type SectionsNumeroSnapshot } from "@/lib/cadastre/history";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/numero — attribue ou modifie le numéro d'une
 * section (numSection NULL : libellé absent ou hors polygone lors de
 * l'extraction ; numSection déjà renseigné : correction manuelle, cf.
 * docs/CONCEPTS-TRAITEMENT-DXF.md §11 ter). Refuse si une AUTRE section de la
 * même commune (syscolCommune) porte déjà ce numéro — le numéro de section
 * n'est unique QUE dans sa commune (cf. build-sections.ts).
 *
 * Capture un snapshot de la section AVANT changement et l'enregistre comme
 * entrée d'historique restaurable, dans la même transaction que l'écriture —
 * cf. docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 * Le revert restaure UNIQUEMENT `numSection` : la resynchronisation NICAD
 * déclenchée ci-dessous (best-effort, hors transaction) n'est pas annulée
 * automatiquement — limitation connue, cf. Global Constraints du plan
 * d'implémentation de cette action.
 *
 * Après écriture, déclenche `syncNicadForSectionChange` pour reconstruire le
 * NICAD des parcelles rattachées (module Map) — best-effort : un échec de
 * synchronisation n'annule pas l'attribution du numéro, déjà actée.
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
    const outcome = await prisma.$transaction(
      async (tx) => {
        const existing = await getSectionFull(sectionId, tx);
        if (!existing) return { kind: "not-found" as const };
        if (existing.numSection === numSection) return { kind: "noop" as const, existing };

        const conflict = await findSectionNumeroConflict(existing.syscolCommune, numSection, sectionId, tx);
        if (conflict) return { kind: "conflict" as const, conflict };

        await updateSectionNumero(sectionId, numSection, tx);
        const before: SectionsNumeroSnapshot = { section: existing };
        await recordHistory(tx, {
          scope: "sections",
          scopeKey: existing.syscolCommune,
          action: "numero",
          summary: `Numéro de la section ${existing.numSection ?? "#" + existing.id} changé en ${numSection}${existing.commune ? ` (${existing.commune})` : ""}`,
          before,
          after: { numSection },
          createdBy,
        });
        return { kind: "ok" as const, existing };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
    }
    if (outcome.kind === "noop") {
      return NextResponse.json({ success: true, sectionId, numSection, nicadSync: null });
    }
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        {
          error: `Le numéro ${numSection} est déjà utilisé par la section #${outcome.conflict.id}${
            outcome.conflict.commune ? ` (${outcome.conflict.commune})` : ""
          } — fusionnez-les si c'est la même section.`,
        },
        { status: 409 },
      );
    }

    let nicadSync: NicadSyncResult | null = null;
    let nicadSyncError: string | null = null;
    try {
      nicadSync = await syncNicadForSectionChange(outcome.existing, numSection);
    } catch (err) {
      console.error("[cadastre/sections/numero] syncNicadForSectionChange", err);
      nicadSyncError = "La mise à jour des NICAD a échoué ; le numéro de section est enregistré.";
    }

    return NextResponse.json({ success: true, sectionId, numSection, nicadSync, nicadSyncError });
  } catch (err) {
    console.error("[cadastre/sections/numero] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
