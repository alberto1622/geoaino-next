import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getSection,
  findSectionNumeroConflict,
  updateSectionNumero,
} from "@/lib/cadastre/sections-data";
import { normalizeSection } from "@/lib/nicad";
import { syncNicadForSectionChange, type NicadSyncResult } from "@/lib/cadastre/nicad-section-sync";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/numero — attribue ou modifie le numéro d'une
 * section (numSection NULL : libellé absent ou hors polygone lors de
 * l'extraction ; numSection déjà renseigné : correction manuelle, cf.
 * docs/CONCEPTS-TRAITEMENT-DXF.md §11 ter). Refuse si une AUTRE section de la
 * même commune (syscolCommune) porte déjà ce numéro — le numéro de section
 * n'est unique QUE dans sa commune (cf. build-sections.ts).
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
    if (existing.numSection === numSection) {
      return NextResponse.json({ success: true, sectionId, numSection, nicadSync: null });
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

    let nicadSync: NicadSyncResult | null = null;
    let nicadSyncError: string | null = null;
    try {
      nicadSync = await syncNicadForSectionChange(existing, numSection);
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
