/**
 * nicad-fill-missing.ts
 *
 * Attribue un NICAD aux parcelles d'une section numérotée qui n'en ont AUCUN
 * (`_nstat = "missing"`, cf. `tile-index.ts`) : incrémentation du numéro de
 * parcelle à partir du dernier numéro déjà utilisé dans la section, en
 * chaînant vers la parcelle sans NICAD la plus proche (plus proche voisin
 * glouton, pas un optimum global — cf. §11 quinquies de
 * `docs/CONCEPTS-TRAITEMENT-DXF.md`).
 *
 * Le cœur de l'algorithme (`fillMissingNicadInFeatures`) est indépendant de
 * la provenance de la section : deux orchestrateurs le réutilisent tel quel,
 * seule leur boucle externe diffère —
 *   - `fillMissingNicadForSection` : UNE section → TOUTES les `Analysis` qui
 *     la couvrent (`/cadastre/sections`, plusieurs tuiles d'un même lot).
 *   - `fillMissingNicadForAnalysis` : UNE `Analysis` → TOUTES ses sections
 *     numérotées (`/map/[analysisId]`, une tuile peut chevaucher plusieurs
 *     sections) — un seul GeoJSON parsé/écrit, même si plusieurs sections y
 *     contribuent des parcelles cibles.
 *
 * Même rattachement section → parcelles que `nicad-section-sync.ts`
 * (`Analysis.fileName === LimiteSection.sourceFichier` + point-dans-polygone) :
 * aucune FK entre les deux tables, ce module réutilise exactement les mêmes
 * conventions.
 *
 * Contrairement à `syncNicadForSectionChange` (qui RECONSTRUIT un NICAD déjà
 * complet), ce module CRÉE des identifiants à partir de rien — il a besoin
 * d'au moins une parcelle déjà numérotée dans la section pour connaître le
 * préfixe territorial et le dernier numéro ; sans référence, rien n'est
 * attribué (`unresolvedCount`).
 */
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { extractNicad } from "@/lib/geo-engine";
import { setFeatureNicad, setFeatureSection, type GeoFeature } from "@/lib/analyses/feature-locator";
import {
  buildNicad,
  normalizeSection,
  normalizeNumeroParcelle,
  NICAD_PREFIX_LENGTH,
  NICAD_PARCELLE_LENGTH,
  NICAD_TOTAL_LENGTH,
} from "@/lib/nicad";

// Alignée sur `geo-engine.ts · isMissingNicadValue` / `tile-index.ts ·
// MISSING_NICAD_VALUES` — dupliquée localement (ni l'une ni l'autre n'est
// exportée), même convention déjà suivie ailleurs dans le code.
const MISSING_NICAD_VALUES = new Set([
  "", "null", "undefined", "na", "n/a", "néant", "neant", "aucun", "sans nicad", "0", "-",
]);
const isMissingNicad = (nicad: string): boolean => MISSING_NICAD_VALUES.has(nicad.trim().toLowerCase());

export interface NicadFillPlan {
  analysisId: number;
  count: number;
  fromParcelle: string;
  toParcelle: string;
}

export interface NicadFillResult {
  analysesUpdated: number;
  parcelsAssigned: number;
  errorsResolved: number;
  analysisIds: number[];
  plans: NicadFillPlan[];
  /** Parcelles sans NICAD trouvées mais non traitées (aucune parcelle déjà numérotée dans la section pour servir de référence). */
  unresolvedCount: number;
}

export interface NicadFillSectionPlan {
  numSection: string;
  count: number;
  fromParcelle: string;
  toParcelle: string;
}

export interface NicadFillAnalysisResult {
  analysisUpdated: boolean;
  parcelsAssigned: number;
  errorsResolved: number;
  /** Une entrée par section numérotée ayant reçu au moins une attribution. */
  plans: NicadFillSectionPlan[];
  unresolvedCount: number;
}

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

const isPolygonal = (f?: GeoFeature): boolean =>
  f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

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

// Même tolérance que `errors/[errorId]/correct/route.ts · geometryApproxEqual`
// (arrondi jsonb) — sert à retrouver, par géométrie, l'erreur MISSING_NICAD
// d'une parcelle qui vient de recevoir un NICAD (pas de clé NICAD utilisable
// puisque `nicad1`/`nicad2` valent `null` pour ce type d'erreur).
function coordsApproxEqual(a: unknown, b: unknown, eps = 1e-7): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < eps;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => coordsApproxEqual(v, b[i], eps));
  }
  return false;
}
function geometryApproxEqual(g1: unknown, g2: unknown): boolean {
  const a = g1 as { type?: string; coordinates?: unknown } | null;
  const b = g2 as { type?: string; coordinates?: unknown } | null;
  if (!a || !b || a.type !== b.type) return false;
  return coordsApproxEqual(a.coordinates, b.coordinates);
}

interface SectionAssignOutcome {
  /** Parcelles cibles (NICAD absent) trouvées dans cette section, avant tentative. */
  missingCount: number;
  assignedIdx: number[];
  firstNum: number | null;
  lastNum: number | null;
}

/**
 * Cœur de l'algorithme, indépendant de la provenance de `features`/section :
 * repère la parcelle de référence (dernier numéro connu) et les parcelles
 * cibles (NICAD absent) rattachées à `sectionPoly` par point-dans-polygone,
 * puis chaîne les cibles par plus proche voisin glouton à partir de la
 * référence. Mute `features` (`setFeatureNicad`/`setFeatureSection`) et
 * `usedNicads` en place.
 */
function fillMissingNicadInFeatures(
  features: GeoFeature[],
  sectionPoly: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
  normalizedSection: string,
  usedNicads: Set<string>,
): SectionAssignOutcome {
  // Parcelles rattachées à la section (point-dans-polygone), séparées entre
  // référence (NICAD complet, pour trouver le dernier numéro + le préfixe)
  // et cibles (NICAD totalement absent).
  let maxParcelleNum = -1;
  let maxParcelleFeatureIdx = -1;
  let prefix8: string | null = null;
  const missingIdx: number[] = [];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (!isPolygonal(feature)) continue;
    const point = representativePoint(feature);
    if (!point) continue;
    let inside = false;
    try {
      inside = turf.booleanPointInPolygon(turf.point(point), sectionPoly);
    } catch {
      continue;
    }
    if (!inside) continue;

    const nicad = extractNicad(feature.properties);
    if (isMissingNicad(nicad)) {
      missingIdx.push(i);
      continue;
    }
    if (nicad.length !== NICAD_TOTAL_LENGTH) continue; // NICAD court : ni référence fiable, ni cible (cf. doc)

    const num = parseInt(nicad.slice(-NICAD_PARCELLE_LENGTH), 10);
    if (!Number.isFinite(num)) continue;
    if (num > maxParcelleNum) {
      maxParcelleNum = num;
      maxParcelleFeatureIdx = i;
      prefix8 = nicad.slice(0, NICAD_PREFIX_LENGTH);
    }
  }

  if (missingIdx.length === 0) {
    return { missingCount: 0, assignedIdx: [], firstNum: null, lastNum: null };
  }
  if (maxParcelleFeatureIdx === -1 || prefix8 === null) {
    return { missingCount: missingIdx.length, assignedIdx: [], firstNum: null, lastNum: null };
  }

  // Chaînage glouton par plus proche voisin, à partir de la position de la
  // parcelle qui porte le dernier numéro.
  let currentPoint = representativePoint(features[maxParcelleFeatureIdx]);
  if (!currentPoint) {
    return { missingCount: missingIdx.length, assignedIdx: [], firstNum: null, lastNum: null };
  }
  let nextNum = maxParcelleNum + 1;
  const firstNum = nextNum;
  const remaining = new Set(missingIdx);
  const assignedIdx: number[] = [];

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestPoint: [number, number] | null = null;
    for (const i of remaining) {
      const p = representativePoint(features[i]);
      if (!p) {
        remaining.delete(i); // géométrie non testable : jamais assignable
        continue;
      }
      const d = turf.distance(turf.point(currentPoint), turf.point(p), { units: "meters" });
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        bestPoint = p;
      }
    }
    if (bestIdx === -1) break;

    const parcelle5 = normalizeNumeroParcelle(String(nextNum)).value;
    const newNicad = parcelle5 ? buildNicad(prefix8, normalizedSection, parcelle5) : null;
    if (!newNicad) {
      remaining.delete(bestIdx);
      continue;
    }
    if (usedNicads.has(newNicad)) {
      // Collision défensive (ne devrait pas arriver : on part au-delà du
      // dernier numéro connu) — on saute ce numéro sans consommer la
      // parcelle, elle sera retentée au numéro suivant.
      nextNum++;
      continue;
    }

    setFeatureNicad(features[bestIdx], newNicad);
    setFeatureSection(features[bestIdx], normalizedSection);
    usedNicads.add(newNicad);
    assignedIdx.push(bestIdx);
    remaining.delete(bestIdx);
    currentPoint = bestPoint ?? currentPoint;
    nextNum++;
  }

  return {
    missingCount: missingIdx.length,
    assignedIdx,
    firstNum: assignedIdx.length > 0 ? firstNum : null,
    lastNum: assignedIdx.length > 0 ? nextNum - 1 : null,
  };
}

/** Résout les erreurs MISSING_NICAD des parcelles d'`assignedIdx` par égalité de géométrie (cf. commentaire `geometryApproxEqual`). */
async function resolveMissingNicadErrors(
  analysisId: number,
  features: GeoFeature[],
  assignedIdx: number[],
): Promise<number[]> {
  if (assignedIdx.length === 0) return [];
  const missingErrors = await prisma.topologicalError.findMany({
    where: { analysisId, errorType: "MISSING_NICAD", corrected: false },
    select: { id: true, geometry: true },
  });
  if (missingErrors.length === 0) return [];
  const resolvedErrorIds: number[] = [];
  for (const idx of assignedIdx) {
    const geom = features[idx].geometry;
    const match = missingErrors.find((e) => geometryApproxEqual(e.geometry, geom));
    if (match) resolvedErrorIds.push(match.id);
  }
  return resolvedErrorIds;
}

export async function fillMissingNicadForSection(
  section: { geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string },
  numSection: string,
  options: { dryRun: boolean },
): Promise<NicadFillResult> {
  const result: NicadFillResult = {
    analysesUpdated: 0,
    parcelsAssigned: 0,
    errorsResolved: 0,
    analysisIds: [],
    plans: [],
    unresolvedCount: 0,
  };
  const normalizedSection = normalizeSection(numSection) ?? numSection;

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

    const usedNicads = new Set<string>();
    for (const f of features) {
      const n = extractNicad(f.properties);
      if (n) usedNicads.add(n);
    }

    const outcome = fillMissingNicadInFeatures(features, sectionPoly, normalizedSection, usedNicads);
    if (outcome.missingCount === 0) continue;
    if (outcome.assignedIdx.length === 0) {
      result.unresolvedCount += outcome.missingCount;
      continue;
    }

    result.plans.push({
      analysisId: analysis.id,
      count: outcome.assignedIdx.length,
      fromParcelle: normalizeNumeroParcelle(String(outcome.firstNum)).value ?? String(outcome.firstNum),
      toParcelle: normalizeNumeroParcelle(String(outcome.lastNum)).value ?? String(outcome.lastNum),
    });
    result.parcelsAssigned += outcome.assignedIdx.length;
    result.unresolvedCount += outcome.missingCount - outcome.assignedIdx.length;

    if (options.dryRun) continue;

    const resolvedErrorIds = await resolveMissingNicadErrors(analysis.id, features, outcome.assignedIdx);

    const correctedGeoJson = JSON.stringify(geoJson);
    const txResults = await prisma.$transaction([
      prisma.analysis.update({
        where: { id: analysis.id },
        data: { correctedData: correctedGeoJson },
      }),
      ...(resolvedErrorIds.length > 0
        ? [
            prisma.topologicalError.updateMany({
              where: { id: { in: resolvedErrorIds } },
              data: { corrected: true },
            }),
          ]
        : []),
    ]);
    if (analysis.geojsonKey) {
      try {
        await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
      } catch {
        /* ignore : correctedData reste la source d'affichage */
      }
    }

    result.analysesUpdated++;
    result.analysisIds.push(analysis.id);
    if (resolvedErrorIds.length > 0) {
      result.errorsResolved += (txResults[1] as { count: number }).count;
    }
  }

  return result;
}

/**
 * Variante scopée à UNE analyse (`/map/[analysisId]`), plutôt qu'à UNE
 * section : parcourt toutes les sections numérotées qui couvrent le fichier
 * source de cette analyse et applique le chaînage de chacune sur le MÊME
 * GeoJSON, avant une écriture unique en fin de traitement (au lieu d'un write
 * par section comme le ferait un appel répété à `fillMissingNicadForSection`).
 *
 * `options.sections` restreint le traitement à un sous-ensemble de numéros de
 * section (sélection côté client, cf. `MapAnalysisClient.tsx`) — omis ou
 * vide, TOUTES les sections numérotées de l'analyse sont traitées.
 */
export async function fillMissingNicadForAnalysis(
  analysisId: number,
  options: { dryRun: boolean; sections?: string[] },
): Promise<NicadFillAnalysisResult> {
  const result: NicadFillAnalysisResult = {
    analysisUpdated: false,
    parcelsAssigned: 0,
    errorsResolved: 0,
    plans: [],
    unresolvedCount: 0,
  };

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { id: true, fileName: true, correctedData: true, geojsonKey: true, geoJsonData: true },
  });
  if (!analysis) return result;

  // Même rattachement que `fillMissingNicadForSection`, sens inverse : une
  // Analysis peut chevaucher plusieurs sections numérotées. `sections` filtre
  // sur les numéros déjà normalisés renvoyés par un aperçu (dryRun) précédent
  // — le `= ANY(...)` exclut de fait les NULL/chaîne vide sans garde séparée.
  const sections =
    options.sections && options.sections.length > 0
      ? await prisma.$queryRaw<Array<{ numSection: string; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon }>>`
          SELECT "numSection", "geomGeoJson"
          FROM "limite_section"
          WHERE "sourceFichier" = ${analysis.fileName} AND "numSection" = ANY(${options.sections})
        `
      : await prisma.$queryRaw<Array<{ numSection: string; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon }>>`
          SELECT "numSection", "geomGeoJson"
          FROM "limite_section"
          WHERE "sourceFichier" = ${analysis.fileName} AND "numSection" IS NOT NULL AND "numSection" <> ''
        `;
  if (sections.length === 0) return result;

  const raw = analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!raw) return result;

  let geoJson: GeoFC;
  try {
    geoJson = JSON.parse(raw);
  } catch {
    return result;
  }
  const features = geoJson.features ?? [];
  if (features.length === 0) return result;

  const usedNicads = new Set<string>();
  for (const f of features) {
    const n = extractNicad(f.properties);
    if (n) usedNicads.add(n);
  }

  const allAssignedIdx: number[] = [];

  for (const section of sections) {
    const normalizedSection = normalizeSection(section.numSection) ?? section.numSection;
    const sectionPoly = turf.feature(section.geomGeoJson);

    const outcome = fillMissingNicadInFeatures(features, sectionPoly, normalizedSection, usedNicads);
    if (outcome.missingCount === 0) continue;
    if (outcome.assignedIdx.length === 0) {
      result.unresolvedCount += outcome.missingCount;
      continue;
    }

    result.plans.push({
      numSection: normalizedSection,
      count: outcome.assignedIdx.length,
      fromParcelle: normalizeNumeroParcelle(String(outcome.firstNum)).value ?? String(outcome.firstNum),
      toParcelle: normalizeNumeroParcelle(String(outcome.lastNum)).value ?? String(outcome.lastNum),
    });
    result.parcelsAssigned += outcome.assignedIdx.length;
    result.unresolvedCount += outcome.missingCount - outcome.assignedIdx.length;
    allAssignedIdx.push(...outcome.assignedIdx);
  }

  if (allAssignedIdx.length === 0 || options.dryRun) return result;

  const resolvedErrorIds = await resolveMissingNicadErrors(analysis.id, features, allAssignedIdx);

  const correctedGeoJson = JSON.stringify(geoJson);
  const txResults = await prisma.$transaction([
    prisma.analysis.update({
      where: { id: analysis.id },
      data: { correctedData: correctedGeoJson },
    }),
    ...(resolvedErrorIds.length > 0
      ? [
          prisma.topologicalError.updateMany({
            where: { id: { in: resolvedErrorIds } },
            data: { corrected: true },
          }),
        ]
      : []),
  ]);
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  result.analysisUpdated = true;
  if (resolvedErrorIds.length > 0) {
    result.errorsResolved = (txResults[1] as { count: number }).count;
  }

  return result;
}
