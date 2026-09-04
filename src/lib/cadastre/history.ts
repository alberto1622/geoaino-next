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
import { Prisma } from "@prisma/client";
import {
  deleteSectionsBySource,
  reinsertLimiteSections,
  reinsertLimiteSectionOverlaps,
  updateSectionNumero,
  type LimiteSectionRow,
  type LimiteSectionOverlapRow,
} from "@/lib/cadastre/sections-data";
import {
  reinsertLimiteSectionAdminMismatches,
  type LimiteSectionAdminMismatchRow,
} from "@/lib/cadastre/admin-mismatch-data";

export type HistoryScope = "sections" | "map";
export type HistoryAction =
  | "delete"
  | "numero"
  | "correct"
  | "correct-batch"
  | "merge"
  | "correct-admin-mismatch"
  | "nicad-fill"
  | "map-delete"
  | "map-rename"
  | "map-merge"
  | "restore";

export interface SectionsDeleteSnapshot {
  sections: LimiteSectionRow[];
  overlaps: LimiteSectionOverlapRow[];
  /** Optionnel : absent des snapshots capturés AVANT l'ajout de ce contrôle
   *  (rétrocompatibilité des entrées d'historique déjà en base). */
  adminMismatches?: LimiteSectionAdminMismatchRow[];
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

export interface RevertDiskWrite {
  geojsonKey: string;
  content: string;
}

export type RevertFn = (
  tx: Prisma.TransactionClient,
  before: unknown,
  scopeKey: string | null,
) => Promise<{ diskWrites?: RevertDiskWrite[] } | void>;

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
  await reinsertLimiteSectionAdminMismatches(snapshot.adminMismatches ?? [], tx);
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
  await reinsertLimiteSectionAdminMismatches(snapshot.adminMismatches ?? [], tx);
}

/** Revert de `nicad-fill` : réécrit `Analysis.correctedData`, les stats
 * agrégées (`errorCount`/`conformityScore`/`summaryStats`) et remet
 * `corrected = false` sur les `TopologicalError` que l'attribution avait
 * résolues — une entrée par `Analysis` effectivement modifiée par l'appel
 * d'origine (une section peut couvrir plusieurs tuiles/analyses). Comme
 * `revertMap`, ne touche pas au disque elle-même : accumule une écriture en
 * attente par `Analysis` ayant un `geojsonKey`, à flusher par l'appelant une
 * fois la transaction commitée. */
async function revertNicadFill(
  tx: Prisma.TransactionClient,
  before: unknown,
): Promise<{ diskWrites?: RevertDiskWrite[] }> {
  const snapshot = before as import("@/lib/cadastre/nicad-fill-missing").NicadFillSnapshot;
  if (!Array.isArray(snapshot?.analyses)) {
    throw new Error("Snapshot d'attribution NICAD invalide — impossible de restaurer.");
  }
  const diskWrites: RevertDiskWrite[] = [];
  for (const entry of snapshot.analyses) {
    const updated = await tx.analysis.update({
      where: { id: entry.analysisId },
      data: {
        correctedData: entry.correctedGeoJsonBefore,
        ...(entry.statsBefore
          ? {
              errorCount: entry.statsBefore.errorCount,
              conformityScore: entry.statsBefore.conformityScore,
              summaryStats: entry.statsBefore.summaryStats === null ? Prisma.DbNull : entry.statsBefore.summaryStats,
            }
          : {}),
      },
    });
    if (updated.geojsonKey) {
      diskWrites.push({ geojsonKey: updated.geojsonKey, content: entry.correctedGeoJsonBefore });
    }
    if (entry.resolvedErrorIds.length > 0) {
      await tx.topologicalError.updateMany({
        where: { id: { in: entry.resolvedErrorIds } },
        data: { corrected: false },
      });
    }
  }
  return { diskWrites };
}

export interface MapEditSnapshot {
  correctedGeoJson: string;
  errorPatches: { errorId: number; corrected: boolean }[];
}

/** Revert partagé par `map-delete`, `map-rename` et `map-merge` — réécrit
 * `Analysis.correctedData` avec le blob capturé AVANT l'édition et remet les
 * `TopologicalError.corrected` visés à leur état d'alors. Même logique que la
 * route déjà existante `/api/analyses/[id]/history/restore` (utilisée par
 * l'annuler/rétablir en mémoire côté client) — dupliquée ici plutôt
 * qu'appelée en HTTP, car ce revert doit s'exécuter DANS la transaction du
 * generic restore route, pas dans un appel réseau séparé. `scopeKey` porte
 * l'`Analysis.id` (cf. `String(analysisId)` posé par les routes d'édition à
 * la capture) — sans lui, ce revert ne saurait pas QUELLE analyse réécrire.
 *
 * Ne réécrit PAS le fichier GeoJSON sur disque elle-même — la mutation
 * `tx.analysis.update` doit rester DANS la transaction (atomique avec le
 * reste du revert), alors que l'écriture disque doit se produire APRÈS son
 * commit (même posture que `features/delete/route.ts` : le store fichier
 * n'est pas transactionnel, un rollback ne doit jamais laisser un fichier
 * en avance sur la DB). Renvoie donc l'écriture en attente à l'appelant, qui
 * la exécute une fois la transaction résolue. */
async function revertMap(
  tx: Prisma.TransactionClient,
  before: unknown,
  scopeKey: string | null,
): Promise<{ diskWrites?: RevertDiskWrite[] }> {
  const snapshot = before as MapEditSnapshot;
  if (typeof snapshot?.correctedGeoJson !== "string" || !Array.isArray(snapshot.errorPatches)) {
    throw new Error("Snapshot de modification carte invalide — impossible de restaurer.");
  }
  const analysisId = Number(scopeKey);
  if (!Number.isInteger(analysisId)) {
    throw new Error("scopeKey invalide pour une restauration carte (analysisId attendu).");
  }

  let totalFeatures: number | undefined;
  try {
    const parsed = JSON.parse(snapshot.correctedGeoJson) as { features?: unknown[] };
    totalFeatures = Array.isArray(parsed.features) ? parsed.features.length : undefined;
  } catch {
    totalFeatures = undefined;
  }

  const updated = await tx.analysis.update({
    where: { id: analysisId },
    data: {
      correctedData: snapshot.correctedGeoJson,
      ...(totalFeatures != null ? { totalFeatures } : {}),
    },
  });

  const correctedIds = snapshot.errorPatches.filter((p) => p.corrected).map((p) => p.errorId);
  const uncorrectedIds = snapshot.errorPatches.filter((p) => !p.corrected).map((p) => p.errorId);
  if (correctedIds.length > 0) {
    await tx.topologicalError.updateMany({
      where: { analysisId, id: { in: correctedIds } },
      data: { corrected: true },
    });
  }
  if (uncorrectedIds.length > 0) {
    await tx.topologicalError.updateMany({
      where: { analysisId, id: { in: uncorrectedIds } },
      data: { corrected: false },
    });
  }

  return updated.geojsonKey
    ? { diskWrites: [{ geojsonKey: updated.geojsonKey, content: snapshot.correctedGeoJson }] }
    : {};
}

// Un handler par action instrumentée. Une action sans handler ici ne peut pas
// encore être restaurée (la route restore répond 400).
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
  correct: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-batch": (tx, before) => revertSectionsSnapshot(tx, before),
  merge: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-admin-mismatch": (tx, before) => revertSectionsSnapshot(tx, before),
  "nicad-fill": (tx, before) => revertNicadFill(tx, before),
  "map-delete": revertMap,
  "map-rename": revertMap,
  "map-merge": revertMap,
};

export function getRevertHandler(action: string): RevertFn | undefined {
  return REVERT_HANDLERS[action];
}
