/**
 * history.ts — capture et restauration des modifications sections/parcelles.
 *
 * Une entrée `CadHistoryEntry` = une action utilisateur (pas une ligne de
 * table) : `before`/`after` sont des snapshots JSON auto-suffisants (pas de
 * FK vers les lignes réelles, qui peuvent avoir disparu depuis). La
 * restauration ne modifie jamais l'entrée ciblée — elle écrit une NOUVELLE
 * entrée `action: "restore"` : l'historique reste append-only et une
 * restauration est elle-même annulable. Cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
import type { Prisma } from "@prisma/client";
import {
  reinsertLimiteSections,
  reinsertLimiteSectionOverlaps,
  type LimiteSectionRow,
  type LimiteSectionOverlapRow,
} from "@/lib/cadastre/sections-data";

export type HistoryScope = "sections" | "map";
export type HistoryAction =
  | "delete"
  | "numero"
  | "correct"
  | "correct-batch"
  | "merge"
  | "nicad-fill"
  | "map-delete"
  | "map-rename"
  | "restore";

export interface SectionsDeleteSnapshot {
  sections: LimiteSectionRow[];
  overlaps: LimiteSectionOverlapRow[];
}

/** Écrit une entrée d'historique — appeler DANS la même transaction que la
 * mutation qu'elle documente (capture + mutation + historique atomiques). */
export async function recordHistory(
  tx: Prisma.TransactionClient,
  entry: {
    scope: HistoryScope;
    scopeKey?: string | null;
    action: HistoryAction;
    summary: string;
    before: unknown;
    after: unknown;
    createdBy?: string | null;
  },
): Promise<void> {
  await tx.cadHistoryEntry.create({
    data: {
      scope: entry.scope,
      scopeKey: entry.scopeKey ?? null,
      action: entry.action,
      summary: entry.summary,
      before: entry.before as Prisma.InputJsonValue,
      after: entry.after as Prisma.InputJsonValue,
      createdBy: entry.createdBy ?? null,
    },
  });
}

export type RevertFn = (tx: Prisma.TransactionClient, before: unknown) => Promise<void>;

async function revertDelete(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as SectionsDeleteSnapshot;
  await reinsertLimiteSections(snapshot.sections, tx);
  await reinsertLimiteSectionOverlaps(snapshot.overlaps, tx);
}

// Un handler par action instrumentée — grandit au fil des plans qui
// instrumentent chacune des routes mutantes restantes (numero, correct,
// correct-batch, merge, nicad-fill, map-delete, map-rename). Une action sans
// handler ici ne peut pas encore être restaurée (la route restore répond 400).
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: revertDelete,
};

export function getRevertHandler(action: string): RevertFn | undefined {
  return REVERT_HANDLERS[action];
}
