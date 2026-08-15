/**
 * overlap-correction.ts — résolution d'UN chevauchement `limite_section`.
 * Logique partagée entre `correct/route.ts` (un chevauchement) et
 * `correct-batch/route.ts` (plusieurs, séquentiellement).
 *
 * Ne recalcule PAS les chevauchements du lot (`refreshOverlaps`) — à charge
 * de l'appelant, pour que le traitement par lot ne le fasse qu'une seule
 * fois à la fin au lieu d'une fois par chevauchement traité.
 *
 * `applyOverlapCorrection` capture un snapshot complet (sections + overlaps
 * touchés) AVANT mutation et le renvoie à l'appelant : `applyOverlapCorrectionWithHistory`
 * l'utilise pour écrire une entrée `CadHistoryEntry` restaurable dans la même
 * transaction que la mutation — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import {
  getOverlap,
  getOverlapFull,
  getSectionFull,
  getOverlapsForSection,
  updateSectionGeometry,
  deleteSection,
  setOverlapStatus,
  type Db,
  type LimiteSectionOverlapRow,
} from "@/lib/cadastre/sections-data";
import { recordHistory, type SectionsDeleteSnapshot } from "@/lib/cadastre/history";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type OverlapAction =
  | "clip_a"
  | "clip_b"
  | "auto"
  | "merge_a"
  | "merge_b"
  | "delete_a"
  | "delete_b"
  | "ignore";

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

function dedupeOverlaps(rows: LimiteSectionOverlapRow[]): LimiteSectionOverlapRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Array.from(byId.values());
}

/**
 * Résout un chevauchement (une action). Actions :
 *  - `clip_a` / `clip_b` : retire l'intersection de la section A (ou B) —
 *    `turf.difference` ; cible entièrement couverte → supprimée ;
 *  - `auto` : compare l'aire de A et de B (`turf.area`), découpe la plus
 *    GRANDE des deux (équivalent à `clip_a` ou `clip_b` selon le cas) — à
 *    aire égale, découpe B (choix arbitraire mais déterministe) ;
 *  - `merge_a` / `merge_b` : fusionne A et B (`turf.union`) en conservant la
 *    géométrie fusionnée sur la section choisie (A ou B), l'autre est
 *    supprimée — le côté conservé garde son numéro, sa commune et son lot ;
 *  - `delete_a` / `delete_b` : supprime la section choisie ;
 *  - `ignore` : marque le chevauchement intentionnel (IGNORED).
 * Renvoie les LOTS touchés (A et B peuvent appartenir à deux lots différents
 * depuis que `refreshOverlaps` détecte aussi les chevauchements croisés entre
 * lots — cf. sections-data.ts) ET un snapshot des lignes touchées (AVANT
 * mutation), pour permettre à l'appelant d'enregistrer une entrée
 * d'historique restaurable et de rafraîchir les DEUX lots (même principe que
 * `merge/route.ts`, qui gère déjà des sections de lots différents). Lève une
 * `Error` si l'overlap ou une section est introuvable, ou si la fusion échoue.
 */
export async function applyOverlapCorrection(
  overlapId: number,
  action: OverlapAction,
  db: Db = prisma,
): Promise<{ lots: string[]; snapshot: SectionsDeleteSnapshot }> {
  const ov = await getOverlap(overlapId, db);
  if (!ov) throw new Error("Chevauchement introuvable");

  if (action === "ignore") {
    const overlapFull = await getOverlapFull(overlapId, db);
    if (!overlapFull) throw new Error("Chevauchement introuvable");
    await setOverlapStatus(overlapId, "IGNORED", db);
    return { lots: [ov.sourceFichier], snapshot: { sections: [], overlaps: [overlapFull] } };
  }

  const [a, b] = await Promise.all([getSectionFull(ov.sectionAId, db), getSectionFull(ov.sectionBId, db)]);
  if (!a || !b) throw new Error("Section introuvable");
  const lots = Array.from(new Set([a.sourceFichier, b.sourceFichier]));
  const [overlapFull, overlapsA, overlapsB] = await Promise.all([
    getOverlapFull(overlapId, db),
    getOverlapsForSection(ov.sectionAId, db),
    getOverlapsForSection(ov.sectionBId, db),
  ]);
  if (!overlapFull) throw new Error("Chevauchement introuvable");
  const snapshot: SectionsDeleteSnapshot = {
    sections: [a, b],
    overlaps: dedupeOverlaps([overlapFull, ...overlapsA, ...overlapsB]),
  };

  const fa = turf.feature(a.geomGeoJson);
  const fb = turf.feature(b.geomGeoJson);

  if (action === "clip_a" || action === "clip_b" || action === "auto") {
    const resolved: "clip_a" | "clip_b" =
      action === "auto"
        ? areaM2(a.geomGeoJson) > areaM2(b.geomGeoJson)
          ? "clip_a"
          : "clip_b"
        : action;
    const targetId = resolved === "clip_a" ? ov.sectionAId : ov.sectionBId;
    const [tf, other] = resolved === "clip_a" ? [fa, fb] : [fb, fa];
    const diff = turf.difference(turf.featureCollection([tf, other]));
    if (!diff || !diff.geometry) {
      await deleteSection(targetId, db); // cible entièrement couverte
    } else {
      const g = diff.geometry as PolyGeom;
      await updateSectionGeometry(targetId, g, areaM2(g), db);
    }
  } else if (action === "merge_a" || action === "merge_b") {
    const u = turf.union(turf.featureCollection([fa, fb]));
    if (!u || !u.geometry) throw new Error("Fusion impossible");
    const g = u.geometry as PolyGeom;
    const keepId = action === "merge_a" ? ov.sectionAId : ov.sectionBId;
    const dropId = action === "merge_a" ? ov.sectionBId : ov.sectionAId;
    await updateSectionGeometry(keepId, g, areaM2(g), db);
    await deleteSection(dropId, db);
  } else if (action === "delete_a") {
    await deleteSection(ov.sectionAId, db);
  } else if (action === "delete_b") {
    await deleteSection(ov.sectionBId, db);
  }

  return { lots, snapshot };
}

/**
 * Applique UNE correction de chevauchement ET enregistre l'entrée
 * d'historique correspondante, dans la même transaction — capture + mutation
 * + historique atomiques (cf. history.ts). Partagé par `correct/route.ts`
 * (une entrée par appel, `historyAction: "correct"`) et
 * `correct-batch/route.ts` (une entrée par item traité avec succès,
 * `historyAction: "correct-batch"` — chaque item du lot reste
 * indépendamment restaurable, cf. Global Constraints du plan
 * d'implémentation de cette action pour le choix de ne PAS agréger le lot en
 * une seule entrée).
 */
export async function applyOverlapCorrectionWithHistory(
  overlapId: number,
  action: OverlapAction,
  createdBy: string | null,
  historyAction: "correct" | "correct-batch" = "correct",
): Promise<string[]> {
  return prisma.$transaction(
    async (tx) => {
      const { lots, snapshot } = await applyOverlapCorrection(overlapId, action, tx);
      const first = snapshot.sections[0];
      await recordHistory(tx, {
        scope: "sections",
        scopeKey: first?.syscolCommune ?? null,
        action: historyAction,
        summary:
          first != null
            ? `Correction du chevauchement #${overlapId} (${action}) — ${first.numSection ?? "#" + first.id}${first.commune ? ` (${first.commune})` : ""}`
            : `Chevauchement #${overlapId} ignoré`,
        before: snapshot,
        after: {},
        createdBy,
      });
      return lots;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

/** Statut HTTP pour un message d'erreur levé par `applyOverlapCorrection` — reproduit les codes que `correct/route.ts` renvoyait avant l'extraction. */
export function statusForOverlapError(message: string): number {
  if (message === "Chevauchement introuvable" || message === "Section introuvable") return 404;
  if (message === "Fusion impossible") return 400;
  return 500;
}
