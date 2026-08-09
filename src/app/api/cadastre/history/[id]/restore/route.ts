import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRevertHandler, recordHistory, type HistoryScope } from "@/lib/cadastre/history";

export const runtime = "nodejs";

type Params = Promise<{ id: string }>;

/**
 * POST /api/cadastre/history/[id]/restore — réapplique le `before` d'une
 * entrée d'historique via son handler de retour en arrière (registre dans
 * history.ts). N'édite jamais l'entrée ciblée au-delà de `restoredAt`/
 * `restoredBy` : écrit une NOUVELLE entrée `action: "restore"` à la place —
 * l'historique reste append-only et une restauration reste elle-même
 * annulable.
 */
export async function POST(req: NextRequest, { params }: { params: Params }): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId)) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  const entry = await prisma.cadHistoryEntry.findUnique({ where: { id: entryId } });
  if (!entry) {
    return NextResponse.json({ error: "Entrée d'historique introuvable" }, { status: 404 });
  }

  const revert = getRevertHandler(entry.action);
  if (!revert) {
    return NextResponse.json(
      { error: `La restauration de l'action « ${entry.action} » n'est pas encore prise en charge` },
      { status: 400 },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await revert(tx, entry.before, entry.scopeKey);
      await tx.cadHistoryEntry.update({
        where: { id: entry.id },
        data: { restoredAt: new Date(), restoredBy: createdBy },
      });
      await recordHistory(tx, {
        scope: entry.scope as HistoryScope,
        scopeKey: entry.scopeKey,
        action: "restore",
        summary: `Restauration : ${entry.summary}`,
        before: entry.after,
        after: entry.before,
        createdBy,
      });
    }, {
      maxWait: 10_000,
      timeout: 120_000,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[cadastre/history/restore] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
