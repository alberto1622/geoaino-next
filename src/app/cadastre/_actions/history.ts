"use server";

import { requireUserId } from "./_auth";
import { prisma } from "@/lib/prisma";

/** Dernières modifications sections/parcelles (delete pour l'instant, cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md) —
 * lecture seule ici, la restauration se fait depuis /cadastre/sections où le
 * contexte carte est disponible pour un retour visuel immédiat. */
export async function listSectionsHistoryRecent(input: { limit: number }) {
  await requireUserId();
  return prisma.cadHistoryEntry.findMany({
    where: { scope: "sections" },
    orderBy: { createdAt: "desc" },
    take: input.limit,
    select: { id: true, summary: true, action: true, restoredAt: true, createdAt: true },
  });
}
