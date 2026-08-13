// src/app/api/cadastre/sections/correct-batch/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { applyOverlapCorrectionWithHistory, type OverlapAction } from "@/lib/cadastre/overlap-correction";
import { refreshOverlaps, listSections, listOverlaps } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";
export const maxDuration = 600;

// Fusion/suppression exclues du batch : trop sensibles pour un traitement en
// masse (cf. design doc, portée). Seules les règles de découpe + l'ignorance
// en masse sont couvertes.
const BATCH_ACTIONS = new Set<OverlapAction>(["clip_a", "clip_b", "auto", "ignore"]);

interface BatchResult {
  overlapId: number;
  ok: boolean;
  error?: string;
}

/**
 * POST /api/cadastre/sections/correct-batch — applique la MÊME règle à
 * plusieurs chevauchements en une requête. Traitement SÉQUENTIEL (pas de
 * `Promise.all`) : les corrections modifient des géométries partagées entre
 * sections, un traitement parallèle pourrait lire une géométrie déjà
 * périmée par un item précédent du même lot. Continue même si un item
 * échoue (ex. section déjà supprimée par un item précédent) — `results`
 * distingue réussites/échecs, pas de rollback global du lot. Chaque item
 * réussi capture + mute + enregistre son historique dans sa PROPRE
 * transaction (`applyOverlapCorrectionWithHistory`) — un item raté ne fait
 * disparaître ni la trace ni les mutations des items déjà réussis avant lui.
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

  let body: { overlapIds?: unknown; action?: string; sourceFichier?: string | string[] | null } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }

  const overlapIds = Array.isArray(body.overlapIds)
    ? body.overlapIds.filter((id): id is number => Number.isInteger(id))
    : [];
  const action = body.action as OverlapAction;
  if (overlapIds.length === 0 || !BATCH_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "overlapIds (liste non vide) et action valide requis" },
      { status: 400 },
    );
  }
  if (overlapIds.length > 500) {
    return NextResponse.json(
      { error: "Lot trop volumineux (max 500 chevauchements par appel)." },
      { status: 400 },
    );
  }

  const results: BatchResult[] = [];
  const touchedSources = new Set<string>();
  for (const overlapId of overlapIds) {
    try {
      const lots = await applyOverlapCorrectionWithHistory(overlapId, action, createdBy, "correct-batch");
      if (action !== "ignore") for (const src of lots) touchedSources.add(src);
      results.push({ overlapId, ok: true });
    } catch (err) {
      console.error("[cadastre/sections/correct-batch] item failed", overlapId, err);
      results.push({ overlapId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const src of touchedSources) {
    await refreshOverlaps(src);
  }

  const viewSource = body.sourceFichier ?? null;
  const [sections, overlaps] = await Promise.all([
    listSections(viewSource),
    listOverlaps(viewSource),
  ]);
  return NextResponse.json({ results, sections, overlaps });
}
