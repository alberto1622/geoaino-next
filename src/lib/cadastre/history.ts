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
  deleteSectionsBySource,
  reinsertLimiteSections,
  reinsertLimiteSectionOverlaps,
  updateSectionNumero,
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

export interface SectionsNumeroSnapshot {
  section: LimiteSectionRow;
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

export type RevertFn = (
  tx: Prisma.TransactionClient,
  before: unknown,
  scopeKey: string | null,
) => Promise<void>;

async function revertDelete(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as SectionsDeleteSnapshot;
  if (!Array.isArray(snapshot?.sections) || !Array.isArray(snapshot?.overlaps)) {
    throw new Error("Snapshot de suppression invalide — impossible de restaurer.");
  }
  if (snapshot.sections.length > 1) {
    // Suppression de lot : une restauration doit reproduire exactement l'état
    // du lot au moment de la suppression, pas s'additionner à un lot déjà
    // réimporté depuis (même sourceFichier, nouveaux id) — sinon les sections
    // se dupliquent silencieusement (ON CONFLICT sur id ne peut pas le voir,
    // les id diffèrent). Une suppression d'UNE section n'a pas ce risque : un
    // id jamais réutilisé par la séquence Postgres reste sûr à réinsérer tel
    // quel, et vider tout le sourceFichier dans ce cas effacerait à tort le
    // reste du lot, jamais capturé dans ce snapshot.
    const sources = new Set(snapshot.sections.map((s) => s.sourceFichier));
    for (const src of sources) {
      await deleteSectionsBySource(src, tx);
    }
  }
  await reinsertLimiteSections(snapshot.sections, tx);
  await reinsertLimiteSectionOverlaps(snapshot.overlaps, tx);
}

/** Restaure UNIQUEMENT `numSection` (et `updatedAt`) — ne rejoue pas une
 * éventuelle resynchronisation NICAD déclenchée par le changement d'origine
 * (`syncNicadForSectionChange`), limitation documentée dans le plan
 * d'implémentation de cette action. */
async function revertNumero(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as SectionsNumeroSnapshot;
  if (!snapshot?.section) {
    throw new Error("Snapshot de numéro invalide — impossible de restaurer.");
  }
  await updateSectionNumero(snapshot.section.id, snapshot.section.numSection, tx);
}

/** Revert partagé par `correct`, `correct-batch` et `merge` — les trois
 * n'écrivent jamais que des lignes `limite_section`/`limite_section_overlap`
 * complètes dans `before` (même forme que `SectionsDeleteSnapshot`), donc le
 * même "réinsère/upsère tout ce qui est capturé" suffit dans les trois cas.
 * Contrairement à `revertDelete`, jamais de garde anti-duplication de lot :
 * ces trois actions ne suppriment jamais un `sourceFichier` entier. */
async function revertSectionsSnapshot(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as SectionsDeleteSnapshot;
  if (!Array.isArray(snapshot?.sections) || !Array.isArray(snapshot?.overlaps)) {
    throw new Error("Snapshot invalide — impossible de restaurer.");
  }
  await reinsertLimiteSections(snapshot.sections, tx);
  await reinsertLimiteSectionOverlaps(snapshot.overlaps, tx);
}

// Un handler par action instrumentée. Une action sans handler ici ne peut pas
// encore être restaurée (la route restore répond 400).
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
  correct: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-batch": (tx, before) => revertSectionsSnapshot(tx, before),
  merge: (tx, before) => revertSectionsSnapshot(tx, before),
};

export function getRevertHandler(action: string): RevertFn | undefined {
  return REVERT_HANDLERS[action];
}
