import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getSectionFull,
  getSectionsFullBySource,
  getOverlapsForSection,
  getOverlapsFullBySource,
  deleteSection,
  deleteSectionsBySource,
} from "@/lib/cadastre/sections-data";
import {
  getAdminMismatchesForSection,
  getAdminMismatchesFullBySource,
} from "@/lib/cadastre/admin-mismatch-data";
import { recordHistory, type SectionsDeleteSnapshot } from "@/lib/cadastre/history";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/delete — supprime des lignes `limite_section` :
 *  - `{ sourceFichier }` : tout le lot d'un fichier chargé (sections +
 *    chevauchements associés) ;
 *  - `{ sectionId }` : une seule section (ses chevauchements référencés sont
 *    retirés par `deleteSection` ; en supprimer une ne peut pas en créer).
 *
 * Capture un snapshot complet AVANT suppression et l'enregistre comme entrée
 * d'historique restaurable, dans la même transaction que la suppression —
 * cf. docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
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
      const existing = await prisma.$transaction(async (tx) => {
        const section = await getSectionFull(sectionId, tx);
        if (!section) return null;
        const overlaps = await getOverlapsForSection(sectionId, tx);
        const adminMismatches = await getAdminMismatchesForSection(sectionId, tx);
        const before: SectionsDeleteSnapshot = { sections: [section], overlaps, adminMismatches };
        await deleteSection(sectionId, tx);
        await recordHistory(tx, {
          scope: "sections",
          scopeKey: section.syscolCommune,
          action: "delete",
          summary: `Suppression de la section ${section.numSection ?? "#" + section.id}${section.commune ? ` (${section.commune})` : ""}`,
          before,
          after: {},
          createdBy,
        });
        return section;
      }, {
        maxWait: 10_000,
        timeout: 120_000,
      });
      if (!existing) {
        return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
      }
      return NextResponse.json({ success: true, deleted: 1 });
    }

    if (sourceFichier) {
      const deleted = await prisma.$transaction(async (tx) => {
        const sections = await getSectionsFullBySource(sourceFichier, tx);
        // Lot vide : ne rien écrire dans l'historique — une entrée au snapshot
        // vide n'offrirait qu'un bouton « Restaurer » sans effet.
        if (sections.length === 0) return null;
        const overlaps = await getOverlapsFullBySource(sourceFichier, tx);
        const adminMismatches = await getAdminMismatchesFullBySource(sourceFichier, tx);
        const before: SectionsDeleteSnapshot = { sections, overlaps, adminMismatches };
        await deleteSectionsBySource(sourceFichier, tx);
        await recordHistory(tx, {
          scope: "sections",
          scopeKey: sections[0]?.syscolCommune ?? null,
          action: "delete",
          summary: `Suppression du lot « ${sourceFichier} » (${sections.length} section(s))`,
          before,
          after: {},
          createdBy,
        });
        return sections.length;
      }, {
        maxWait: 10_000,
        timeout: 120_000,
      });
      if (deleted == null) {
        return NextResponse.json({ error: "Aucune section trouvée pour ce fichier" }, { status: 404 });
      }
      return NextResponse.json({ success: true, sourceFichier });
    }

    return NextResponse.json({ error: "sectionId ou sourceFichier requis" }, { status: 400 });
  } catch (err) {
    console.error("[cadastre/sections/delete] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
