import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  applyAdminMismatchCorrectionWithHistory,
  statusForAdminMismatchError,
  type AdminMismatchAction,
} from "@/lib/cadastre/admin-mismatch-correction";
import { refreshOverlaps } from "@/lib/cadastre/sections-data";
import { refreshAdminMismatches } from "@/lib/cadastre/admin-mismatch-data";

export const runtime = "nodejs";

const ACTIONS = new Set<AdminMismatchAction>(["clip", "ignore"]);

/**
 * POST /api/cadastre/sections/admin-mismatches/correct — résout un
 * débordement entre une section et une limite administrative. Voir
 * `applyAdminMismatchCorrection` pour le détail des actions. Capture +
 * mutation + historique atomiques. `clip` modifie la géométrie de la
 * section : les DEUX contrôles (chevauchements section↔section ET
 * débordements administratifs) sont rafraîchis pour le lot touché, la
 * correction pouvant affecter l'un comme l'autre.
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

  let body: { mismatchId?: number; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const mismatchId = Number(body.mismatchId);
  const action = body.action as AdminMismatchAction;
  if (!Number.isInteger(mismatchId) || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "mismatchId et action valides requis" }, { status: 400 });
  }

  try {
    const lots = await applyAdminMismatchCorrectionWithHistory(mismatchId, action, createdBy);
    if (action !== "ignore") {
      for (const src of lots) {
        await refreshAdminMismatches(src);
        await refreshOverlaps(src);
      }
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cadastre/sections/admin-mismatches/correct] POST", err);
    return NextResponse.json({ error: message }, { status: statusForAdminMismatchError(message) });
  }
}
