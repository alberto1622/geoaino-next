/**
 * admin-mismatch-correction.ts — résolution d'UN débordement administratif
 * (`limite_section_admin_mismatch`). Calqué sur `overlap-correction.ts`, en
 * plus simple : une seule section est en jeu (pas de paire A/B), la
 * référence de découpage est la géométrie EXACTE de la commune 2026 déclarée
 * sur la section (`syscolCommune`), pas une autre section.
 *
 * Ne recalcule PAS les chevauchements/débordements du lot — à charge de
 * l'appelant (`refreshOverlaps` ET `refreshAdminMismatches`, la géométrie
 * modifiée peut affecter les deux contrôles), même contrat que
 * `applyOverlapCorrection`.
 */
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import {
  getSectionFull,
  getOverlapsForSection,
  updateSectionGeometry,
  type Db,
} from "@/lib/cadastre/sections-data";
import {
  getAdminMismatch,
  getAdminMismatchFull,
  getAdminMismatchesForSection,
  setAdminMismatchStatus,
  getCommuneGeom,
} from "@/lib/cadastre/admin-mismatch-data";
import { recordHistory, type SectionsDeleteSnapshot } from "@/lib/cadastre/history";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type AdminMismatchAction = "clip" | "ignore";

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

/**
 * Résout un débordement administratif (une action). Actions :
 *  - `clip` : découpe la section à l'intersection avec la géométrie EXACTE
 *    de SA commune déclarée (`syscolCommune`) — retire la part qui déborde,
 *    quel que soit le niveau (commune/département/région) du mismatch visé,
 *    puisqu'un débordement de département/région implique TOUJOURS un
 *    débordement de commune (le département/la région englobe la commune) :
 *    découper à la commune règle les trois niveaux en une fois ;
 *  - `ignore` : marque le débordement intentionnel/accepté (IGNORED).
 * Renvoie le LOT touché et un snapshot des lignes touchées (AVANT mutation),
 * même contrat que `applyOverlapCorrection`. Lève une `Error` si le
 * débordement, la section ou sa commune de référence est introuvable, ou si
 * le découpage ne produit plus de géométrie (section entièrement hors de sa
 * commune déclarée — signal que c'est la COMMUNE déclarée qui est fausse,
 * pas seulement un débordement partiel ; à corriger manuellement ailleurs,
 * ce module ne réattribue jamais la commune d'une section).
 */
export async function applyAdminMismatchCorrection(
  mismatchId: number,
  action: AdminMismatchAction,
  db: Db = prisma,
): Promise<{ lots: string[]; snapshot: SectionsDeleteSnapshot }> {
  const mm = await getAdminMismatch(mismatchId, db);
  if (!mm) throw new Error("Débordement administratif introuvable");

  if (action === "ignore") {
    const mismatchFull = await getAdminMismatchFull(mismatchId, db);
    if (!mismatchFull) throw new Error("Débordement administratif introuvable");
    await setAdminMismatchStatus(mismatchId, "IGNORED", db);
    return { lots: [mm.sourceFichier], snapshot: { sections: [], overlaps: [], adminMismatches: [mismatchFull] } };
  }

  const section = await getSectionFull(mm.sectionId, db);
  if (!section) throw new Error("Section introuvable");
  if (!section.syscolCommune) throw new Error("Section sans commune déclarée — découpage impossible");
  const communeGeom = await getCommuneGeom(section.syscolCommune, db);
  if (!communeGeom) throw new Error("Commune de référence introuvable");

  const [overlapsForSection, mismatchesForSection] = await Promise.all([
    getOverlapsForSection(mm.sectionId, db),
    getAdminMismatchesForSection(mm.sectionId, db),
  ]);
  const snapshot: SectionsDeleteSnapshot = {
    sections: [section],
    overlaps: overlapsForSection,
    adminMismatches: mismatchesForSection,
  };

  const fs_ = turf.feature(section.geomGeoJson);
  const fCommune = turf.feature(communeGeom);
  const clipped = turf.intersect(turf.featureCollection([fs_, fCommune]));
  if (!clipped || !clipped.geometry) {
    throw new Error("Découpage impossible — la section ne recoupe plus sa commune déclarée");
  }
  const g = clipped.geometry as PolyGeom;
  await updateSectionGeometry(mm.sectionId, g, areaM2(g), db);

  return { lots: [mm.sourceFichier], snapshot };
}

/**
 * Applique UNE correction de débordement administratif ET enregistre
 * l'entrée d'historique correspondante, dans la même transaction — même
 * principe que `applyOverlapCorrectionWithHistory`.
 */
export async function applyAdminMismatchCorrectionWithHistory(
  mismatchId: number,
  action: AdminMismatchAction,
  createdBy: string | null,
): Promise<string[]> {
  return prisma.$transaction(
    async (tx) => {
      const { lots, snapshot } = await applyAdminMismatchCorrection(mismatchId, action, tx);
      const first = snapshot.sections[0];
      await recordHistory(tx, {
        scope: "sections",
        scopeKey: first?.syscolCommune ?? null,
        action: "correct-admin-mismatch",
        summary:
          first != null
            ? `Correction du débordement administratif #${mismatchId} (${action}) — ${first.numSection ?? "#" + first.id}${first.commune ? ` (${first.commune})` : ""}`
            : `Débordement administratif #${mismatchId} ignoré`,
        before: snapshot,
        after: {},
        createdBy,
      });
      return lots;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

/** Statut HTTP pour un message d'erreur levé par `applyAdminMismatchCorrection`. */
export function statusForAdminMismatchError(message: string): number {
  if (
    message === "Débordement administratif introuvable" ||
    message === "Section introuvable" ||
    message === "Commune de référence introuvable"
  ) {
    return 404;
  }
  if (
    message === "Section sans commune déclarée — découpage impossible" ||
    message === "Découpage impossible — la section ne recoupe plus sa commune déclarée"
  ) {
    return 400;
  }
  return 500;
}
