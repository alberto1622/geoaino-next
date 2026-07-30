import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  applyOverlapCorrection,
  statusForOverlapError,
  type OverlapAction,
} from "@/lib/cadastre/overlap-correction";
import { refreshOverlaps, listSections, listOverlaps } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

// "auto" est réservé au traitement par lot (`correct-batch` — n'a de sens
// que comparé à un groupe de chevauchements) : cette route à chevauchement
// unique garde EXACTEMENT le même ensemble d'actions qu'avant l'extraction
// (aucun changement d'interface HTTP), donc ne l'inclut pas.
const SINGLE_CORRECT_ACTIONS = new Set<OverlapAction>([
  "clip_a",
  "clip_b",
  "merge",
  "delete_a",
  "delete_b",
  "ignore",
]);

/**
 * POST /api/cadastre/sections/correct — résout un chevauchement entre deux
 * sections (une seule paire). Voir `applyOverlapCorrection` pour le détail
 * des actions. Renvoie les sections + chevauchements à jour du lot concerné.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

  let body: { overlapId?: number; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const overlapId = Number(body.overlapId);
  const action = body.action as OverlapAction;
  if (!Number.isInteger(overlapId) || !SINGLE_CORRECT_ACTIONS.has(action)) {
    return NextResponse.json({ error: "overlapId et action valides requis" }, { status: 400 });
  }

  try {
    const src = await applyOverlapCorrection(overlapId, action);
    if (action !== "ignore") {
      await refreshOverlaps(src);
    }
    const [sections, overlaps] = await Promise.all([listSections(src), listOverlaps(src)]);
    return NextResponse.json({ success: true, sections, overlaps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cadastre/sections/correct] POST", err);
    return NextResponse.json({ error: message }, { status: statusForOverlapError(message) });
  }
}
