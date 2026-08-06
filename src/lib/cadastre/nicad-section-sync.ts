/**
 * nicad-section-sync.ts
 *
 * Reconstruit le NICAD ET le numéro de section (propriété `numero_section`,
 * distincte du NICAD) des parcelles rattachées à une `limite_section` dont le
 * numéro vient d'être attribué ou modifié (cf. `POST
 * /api/cadastre/sections/numero`). Sans la mise à jour de `numero_section`,
 * la classification « sans section » (`_ssec`, `tile-index.ts`) reste périmée
 * même après un NICAD correct — ce sont deux propriétés indépendantes sur la
 * feature. Deux systèmes déconnectés sont en jeu :
 *
 *   - `LimiteSection` (table `limite_section`) : sections QA extraites d'un
 *     DXF, sans FK vers les parcelles (job d'import `kind: "sections"`).
 *   - `Analysis` : parcelles + NICAD du module Map (`correctedData`), produit
 *     par le job d'import complet (job `kind` par défaut, `run-job.ts`).
 *
 * Faute de clé stable entre les deux, le rattachement se fait :
 *   - entre lots : par égalité `Analysis.fileName === LimiteSection.sourceFichier`
 *     (seul lien exploitable — deux jobs distincts, même nom de fichier source) ;
 *   - entre parcelles et section : par point-dans-polygone (même logique que
 *     `findSectionNumero` en ingestion, `parcelle-ingestion.ts`), le NICAD
 *     n'étant pas relié par FK à la géométrie de section.
 *
 * Une collision (NICAD reconstruit déjà porté par une autre parcelle de la
 * même Analysis) est reportée sans être appliquée — jamais d'écrasement
 * silencieux (cf. `docs/CONCEPTS-TRAITEMENT-DXF.md` §9, doublures NICAD).
 */
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { extractNicad } from "@/lib/geo-engine";
import { setFeatureNicad, setFeatureSection, type GeoFeature } from "@/lib/analyses/feature-locator";
import {
  buildNicad,
  normalizeSection,
  NICAD_PREFIX_LENGTH,
  NICAD_PARCELLE_LENGTH,
  NICAD_TOTAL_LENGTH,
} from "@/lib/nicad";

export interface NicadSyncConflict {
  analysisId: number;
  oldNicad: string;
  newNicad: string;
}

export interface NicadSyncResult {
  analysesUpdated: number;
  parcelsUpdated: number;
  conflicts: NicadSyncConflict[];
  /** Erreurs DUPLICATE marquées corrigées (le NICAD reconstruit ne laisse plus qu'une occurrence). */
  errorsResolved: number;
  /** Analyses effectivement modifiées — sert à notifier les onglets `/map/[id]` déjà ouverts. */
  analysisIds: number[];
}

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

const isPolygonal = (f?: GeoFeature): boolean =>
  f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

/** Point garanti à l'intérieur de la géométrie (repli centroïde), cf. `parcelle-ingestion.ts`. */
function representativePoint(feature: GeoFeature): [number, number] | null {
  try {
    return turf.pointOnFeature(feature as never).geometry.coordinates as [number, number];
  } catch {
    try {
      return turf.centroid(feature as never).geometry.coordinates as [number, number];
    } catch {
      return null;
    }
  }
}

export async function syncNicadForSectionChange(
  section: { geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string },
  newNumSection: string,
): Promise<NicadSyncResult> {
  const result: NicadSyncResult = {
    analysesUpdated: 0,
    parcelsUpdated: 0,
    conflicts: [],
    errorsResolved: 0,
    analysisIds: [],
  };
  const normalizedSection = normalizeSection(newNumSection) ?? newNumSection;

  const analyses = await prisma.analysis.findMany({
    where: { fileName: section.sourceFichier },
    select: { id: true, correctedData: true, geojsonKey: true, geoJsonData: true },
  });
  if (analyses.length === 0) return result;

  const sectionPoly = turf.feature(section.geomGeoJson);

  for (const analysis of analyses) {
    const raw =
      analysis.correctedData ??
      (await loadGeoJsonFromKey(analysis.geojsonKey)) ??
      analysis.geoJsonData;
    if (!raw) continue;

    let geoJson: GeoFC;
    try {
      geoJson = JSON.parse(raw);
    } catch {
      continue;
    }
    const features = geoJson.features ?? [];
    if (features.length === 0) continue;

    // Occurrences par NICAD dans cette Analysis (contrôle de collision local ET
    // détection des doublures résolues par la reconstruction, cf. §9/§10). Un
    // simple Set ne suffit pas : un NICAD en doublure a plusieurs occurrences,
    // en retirer une seule ne le libère pas pour autant.
    const nicadCounts = new Map<string, number>();
    for (const f of features) {
      const n = extractNicad(f.properties);
      if (n) nicadCounts.set(n, (nicadCounts.get(n) ?? 0) + 1);
    }
    const duplicateAtStart = new Set<string>();
    for (const [n, c] of nicadCounts) if (c > 1) duplicateAtStart.add(n);
    const touchedOldNicads = new Set<string>();

    let updatedInAnalysis = 0;
    for (const feature of features) {
      if (!isPolygonal(feature)) continue;

      const oldNicad = extractNicad(feature.properties);
      // NICAD absent ou incomplet ("court", cf. §10) : rien à reconstruire en sécurité.
      if (!oldNicad || oldNicad.length !== NICAD_TOTAL_LENGTH) continue;

      const point = representativePoint(feature);
      if (!point) continue;

      let inside = false;
      try {
        inside = turf.booleanPointInPolygon(turf.point(point), sectionPoly);
      } catch {
        continue;
      }
      if (!inside) continue;

      const prefix8 = oldNicad.slice(0, NICAD_PREFIX_LENGTH);
      const parcelle5 = oldNicad.slice(-NICAD_PARCELLE_LENGTH);
      const newNicad = buildNicad(prefix8, normalizedSection, parcelle5);
      if (!newNicad || newNicad === oldNicad) continue;

      if ((nicadCounts.get(newNicad) ?? 0) > 0) {
        result.conflicts.push({ analysisId: analysis.id, oldNicad, newNicad });
        continue;
      }

      setFeatureNicad(feature, newNicad);
      setFeatureSection(feature, normalizedSection);
      nicadCounts.set(oldNicad, (nicadCounts.get(oldNicad) ?? 1) - 1);
      nicadCounts.set(newNicad, (nicadCounts.get(newNicad) ?? 0) + 1);
      touchedOldNicads.add(oldNicad);
      updatedInAnalysis++;
    }

    if (updatedInAnalysis === 0) continue;

    const correctedGeoJson = JSON.stringify(geoJson);

    // NICAD qui portaient une erreur DUPLICATE et ne comptent plus qu'une
    // occurrence après reconstruction : la doublure est réellement résolue
    // (pas seulement déplacée) — colorer/lister l'erreur comme corrigée.
    // Reste PENDING si ≥ 2 occurrences subsistent (doublure réelle, indépendante
    // de cette section).
    const resolvedDuplicateNicads = [...touchedOldNicads].filter(
      (n) => duplicateAtStart.has(n) && (nicadCounts.get(n) ?? 0) <= 1,
    );

    const txResults = await prisma.$transaction([
      prisma.analysis.update({
        where: { id: analysis.id },
        data: { correctedData: correctedGeoJson },
      }),
      ...(resolvedDuplicateNicads.length > 0
        ? [
            prisma.topologicalError.updateMany({
              where: {
                analysisId: analysis.id,
                errorType: "DUPLICATE",
                corrected: false,
                nicad1: { in: resolvedDuplicateNicads },
              },
              data: { corrected: true },
            }),
          ]
        : []),
    ]);
    if (analysis.geojsonKey) {
      try {
        await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
      } catch {
        /* ignore : correctedData reste la source d'affichage (même repli que update-nicad) */
      }
    }

    result.analysesUpdated++;
    result.analysisIds.push(analysis.id);
    result.parcelsUpdated += updatedInAnalysis;
    if (resolvedDuplicateNicads.length > 0) {
      result.errorsResolved += (txResults[1] as { count: number }).count;
    }
  }

  return result;
}
