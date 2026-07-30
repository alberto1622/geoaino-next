/**
 * overlap-correction.ts — résolution d'UN chevauchement `limite_section`.
 * Logique partagée entre `correct/route.ts` (un chevauchement) et
 * `correct-batch/route.ts` (plusieurs, séquentiellement) : sortie de
 * `correct/route.ts` pour éviter de la dupliquer.
 *
 * Ne recalcule PAS les chevauchements du lot (`refreshOverlaps`) — à charge
 * de l'appelant, pour que le traitement par lot ne le fasse qu'une seule
 * fois à la fin au lieu d'une fois par chevauchement traité.
 */
import * as turf from "@turf/turf";
import {
  getOverlap,
  getSection,
  updateSectionGeometry,
  deleteSection,
  setOverlapStatus,
} from "@/lib/cadastre/sections-data";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type OverlapAction =
  | "clip_a"
  | "clip_b"
  | "auto"
  | "merge"
  | "delete_a"
  | "delete_b"
  | "ignore";

export const OVERLAP_ACTIONS = new Set<OverlapAction>([
  "clip_a",
  "clip_b",
  "auto",
  "merge",
  "delete_a",
  "delete_b",
  "ignore",
]);

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

/**
 * Résout un chevauchement (une action). Actions :
 *  - `clip_a` / `clip_b` : retire l'intersection de la section A (ou B) —
 *    `turf.difference` ; cible entièrement couverte → supprimée ;
 *  - `auto` : compare l'aire de A et de B (`turf.area`), découpe la plus
 *    GRANDE des deux (équivalent à `clip_a` ou `clip_b` selon le cas) — à
 *    aire égale, découpe B (choix arbitraire mais déterministe) ;
 *  - `merge` : fusionne A et B (`turf.union`), B supprimée ;
 *  - `delete_a` / `delete_b` : supprime la section choisie ;
 *  - `ignore` : marque le chevauchement intentionnel (IGNORED).
 * Retourne le `sourceFichier` de l'overlap traité. Lève une `Error` si
 * l'overlap ou une section est introuvable, ou si la fusion échoue.
 */
export async function applyOverlapCorrection(
  overlapId: number,
  action: OverlapAction,
): Promise<string> {
  const ov = await getOverlap(overlapId);
  if (!ov) throw new Error("Chevauchement introuvable");

  if (action === "ignore") {
    await setOverlapStatus(overlapId, "IGNORED");
    return ov.sourceFichier;
  }

  const [a, b] = await Promise.all([getSection(ov.sectionAId), getSection(ov.sectionBId)]);
  if (!a || !b) throw new Error("Section introuvable");
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
      await deleteSection(targetId); // cible entièrement couverte
    } else {
      const g = diff.geometry as PolyGeom;
      await updateSectionGeometry(targetId, g, areaM2(g));
    }
  } else if (action === "merge") {
    const u = turf.union(turf.featureCollection([fa, fb]));
    if (!u || !u.geometry) throw new Error("Fusion impossible");
    const g = u.geometry as PolyGeom;
    await updateSectionGeometry(ov.sectionAId, g, areaM2(g));
    await deleteSection(ov.sectionBId);
  } else if (action === "delete_a") {
    await deleteSection(ov.sectionAId);
  } else if (action === "delete_b") {
    await deleteSection(ov.sectionBId);
  }

  return ov.sourceFichier;
}

/** Statut HTTP pour un message d'erreur levé par `applyOverlapCorrection` — reproduit les codes que `correct/route.ts` renvoyait avant l'extraction. */
export function statusForOverlapError(message: string): number {
  if (message === "Chevauchement introuvable" || message === "Section introuvable") return 404;
  if (message === "Fusion impossible") return 400;
  return 500;
}
