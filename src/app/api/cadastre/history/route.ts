import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/cadastre/history?scope=sections|map&scopeKey=<...>&limit=<n>
 *
 * Liste l'historique des modifications, le plus récent en premier.
 * `scopeKey` filtre sur la commune (sections) ou l'id d'analyse (map) —
 * omis, renvoie toutes les entrées du scope. Ne renvoie PAS `before`/`after`
 * (des snapshots de géométrie complets, potentiellement volumineux) : la
 * restauration les recharge par id côté serveur, la liste n'en a pas besoin.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope");
  if (scope !== "sections" && scope !== "map") {
    return NextResponse.json({ error: "scope invalide (sections|map)" }, { status: 400 });
  }
  const scopeKey = searchParams.get("scopeKey");
  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const entries = await prisma.cadHistoryEntry.findMany({
    where: { scope, ...(scopeKey ? { scopeKey } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      scope: true,
      scopeKey: true,
      action: true,
      summary: true,
      restoredAt: true,
      restoredBy: true,
      createdAt: true,
      createdBy: true,
    },
  });
  return NextResponse.json({ entries });
}
