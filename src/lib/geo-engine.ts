import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { BBoxGridIndex, bboxIntersects, type BBox } from "./parcelle-ingestion";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GeoFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

export interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

export interface AnalysisResult {
  totalFeatures: number;
  errors: Array<{
    type: string;
    severity: string;
    nicad1?: string | null;
    nicad2?: string | null;
    description: string;
    area?: number;
    confidence: number;
    geometry?: unknown;
  }>;
  stats: {
    totalSurface: number;
    avgSurface: number;
    overlapCount: number;
    sliverCount: number;
    duplicateCount: number;
    invalidCount: number;
    missingNicadCount: number;
    shortNicadErrorCount: number;
    conformeCount: number;
    nonConformeCount: number;
    withNicadCount: number;
    withoutNicadCount: number;
    shortNicadCount: number;
    invalidLengthNicadCount: number;
    validNicad16Count: number;
    qgisControl: {
      totalParcelles: number;
      parcellesAvecNicad: number;
      parcellesSansNicad: number;
      nicadCourtMoins8: number;
      nicadLongueurDifferente16: number;
      nicadValide16: number;
    };
    conformityScore: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractObjectId(props: Record<string, unknown>, fallbackIndex: number): string {
  const val =
    props.OBJECTID ?? props.objectid ?? props.ObjectID ??
    props.FID ?? props.fid ?? props.OBJ_ID ?? props.GID ?? props.id;
  return val != null ? String(val) : String(fallbackIndex);
}

function computeArea(coords: number[][]): number {
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n - 1; i++) {
    area += coords[i][0] * coords[i + 1][1];
    area -= coords[i + 1][0] * coords[i][1];
  }
  return Math.abs(area / 2);
}

function getBBox(coords: number[][]): [number, number, number, number] {
  const xs = coords.map((c) => c[0]);
  const ys = coords.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function isValidGeometry(feature: GeoFeature): boolean {
  try {
    const geom = feature.geometry;
    if (!geom || !geom.type || !geom.coordinates) return false;
    if (geom.type === "Polygon") {
      const coords = geom.coordinates as number[][][];
      if (!coords[0] || coords[0].length < 4) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getPolygonCoords(feature: GeoFeature): number[][] | null {
  try {
    const geom = feature.geometry;
    if (geom.type === "Polygon") return (geom.coordinates as number[][][])[0];
    if (geom.type === "MultiPolygon") return ((geom.coordinates as number[][][][])[0])[0];
    return null;
  } catch {
    return null;
  }
}

/**
 * Détecte si une feature est une parcelle résiduelle (sliver).
 * Critère identique à celui de `analyzeGeoJSON` :
 *  - surface < 1 m² (coordonnées UTM) ou < 1e-10 (coordonnées géographiques), OU
 *  - ratio d'aspect (longueur/largeur de la bbox) > 50.
 * Exporté pour être réutilisé par le module de correction des slivers.
 */
export function detectSliver(feature: GeoFeature): {
  isSliver: boolean;
  area: number;
  aspectRatio: number;
} {
  const coords = getPolygonCoords(feature);
  if (!coords || coords.length < 3) return { isSliver: false, area: 0, aspectRatio: 0 };
  const area = computeArea(coords);
  const bbox = getBBox(coords);
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const aspectRatio = width > 0 && height > 0 ? Math.max(width / height, height / width) : 0;
  const isUtm = Math.abs(coords[0][0]) > 180;
  const minArea = isUtm ? 1 : 1e-10;
  return { isSliver: area < minArea || aspectRatio > 50, area, aspectRatio };
}

export function extractNicad(props: Record<string, unknown> | undefined | null): string {
  if (!props) return "";
  const value =
    props.nicad ?? props.NICAD ?? props.Nicad ?? props.NIC ??
    props.NUM_NICAD ?? props.num_nicad ?? props.CODE_NICAD ??
    props.code_nicad ?? props.CODIF ?? props.codif ?? "";
  return String(value).trim();
}

function isMissingNicadValue(nicad: unknown): boolean {
  const value = String(nicad ?? "").trim().toLowerCase();
  return (
    !value || value === "null" || value === "undefined" || value === "na" ||
    value === "n/a" || value === "néant" || value === "neant" ||
    value === "aucun" || value === "sans nicad" || value === "0" || value === "-"
  );
}

// ── Main Analysis Engine ───────────────────────────────────────────────────────

export function analyzeGeoJSON(
  geojson: GeoFeatureCollection,
  adminBoundary?: GeoFeatureCollection
): AnalysisResult {
  const features = geojson.features || [];
  const errors: AnalysisResult["errors"] = [];

  let totalSurface = 0;
  const surfaces: number[] = [];
  let withNicadCount = 0;
  let withoutNicadCount = 0;
  let shortNicadCount = 0;
  let invalidLengthNicadCount = 0;
  let validNicad16Count = 0;

  const nicadMap = new Map<string, number[]>();
  // Index des features (par position) impliquées dans au moins une erreur. Sert à
  // compter les parcelles conformes de façon fiable même quand le NICAD est absent.
  const nonConformeIdx = new Set<number>();

  // 1. Validity + NICAD check
  features.forEach((f, idx) => {
    const props = f.properties || {};
    const nicad = extractNicad(props);

    if (!isValidGeometry(f)) {
      nonConformeIdx.add(idx);
      errors.push({
        type: "invalid_geom",
        severity: "critical",
        nicad1: nicad || `feature_${idx}`,
        description: `Géométrie invalide ou nulle pour la parcelle ${nicad || idx}`,
        confidence: 1.0,
        geometry: f.geometry,
      });
    }

    const nicadClean = extractNicad(props);
    const idNicad = nicadClean.length;
    const isMissingNicad = isMissingNicadValue(nicadClean);

    if (isMissingNicad || idNicad < 8) withoutNicadCount++;
    else withNicadCount++;
    if (!isMissingNicad && idNicad > 0 && idNicad < 8) shortNicadCount++;
    if (!isMissingNicad && idNicad === 16) validNicad16Count++;
    if (!isMissingNicad && idNicad > 0 && idNicad !== 16) invalidLengthNicadCount++;

    if (isMissingNicad) {
      // NICAD réellement absent (vide, null, néant…) → aucun NICAD à afficher.
      nonConformeIdx.add(idx);
      errors.push({
        type: "missing_nicad",
        severity: "critical",
        nicad1: null,
        nicad2: null,
        description: `Parcelle sans NICAD détectée à l'index ${idx}`,
        confidence: 1.0,
        geometry: f.geometry,
      });
    } else if (idNicad < 8) {
      // NICAD présent mais trop court → on conserve la valeur réelle dans nicad1
      // pour qu'elle s'affiche dans le panneau, cohérente avec le popup carte.
      nonConformeIdx.add(idx);
      errors.push({
        type: "short_nicad",
        severity: "high",
        nicad1: nicadClean,
        nicad2: null,
        description: `NICAD trop court (${idNicad} caractère${idNicad > 1 ? "s" : ""}, minimum 8 attendu) à l'index ${idx} : « ${nicadClean} »`,
        confidence: 1.0,
        geometry: f.geometry,
      });
    } else {
      if (!nicadMap.has(nicadClean)) nicadMap.set(nicadClean, []);
      nicadMap.get(nicadClean)!.push(idx);
    }

    const coords = getPolygonCoords(f);
    if (coords && coords.length >= 3) {
      const { isSliver, area, aspectRatio } = detectSliver(f);
      surfaces.push(area);
      totalSurface += area;

      if (isSliver) {
        nonConformeIdx.add(idx);
        errors.push({
          type: "sliver",
          severity: "medium",
          nicad1: nicad || `feature_${idx}`,
          description: `Parcelle résiduelle (sliver) détectée: surface=${area.toFixed(6)}, ratio=${aspectRatio.toFixed(1)}`,
          area,
          confidence: 0.9,
          geometry: f.geometry,
        });
      }
    }
  });

  // 2. Duplicate NiCAD — one error per occurrence, nicad2 = OBJECTID of this feature
  nicadMap.forEach((indices, nicad) => {
    if (indices.length > 1) {
      // Collect all OBJECTIDs for this NICAD group
      const allObjectIds = indices.map((idx) =>
        extractObjectId(features[idx]?.properties ?? {}, idx)
      );
      indices.forEach((featureIndex, pos) => {
        nonConformeIdx.add(featureIndex);
        const duplicateFeature = features[featureIndex];
        const thisObjectId = allObjectIds[pos];
        const otherObjectIds = allObjectIds.filter((_, i) => i !== pos).join(", ");
        errors.push({
          type: "duplicate",
          severity: "critical",
          nicad1: nicad,
          nicad2: thisObjectId,
          description: `NICAD dupliqué "${nicad}" — ${indices.length} occurrences. OBJECTID: ${thisObjectId} (autres: ${otherObjectIds})`,
          confidence: 1.0,
          geometry: duplicateFeature?.geometry,
        });
      });
    }
  });

  // 3. Overlaps with Turf.js — la totalité des features est vérifiée (plus de
  // troncature aux 500 premières) via un index spatial en grille (BBoxGridIndex,
  // cf. parcelle-ingestion.ts) : sur un gros lot, la comparaison exhaustive par
  // paires resterait O(n²), l'index ne compare que les voisins de bbox proches.
  const overlapFeatures = features;
  const firstCoords0 = overlapFeatures[0] ? getPolygonCoords(overlapFeatures[0]) : null;
  const coordsAreUtm = firstCoords0 ? Math.abs(firstCoords0[0][0]) > 180 : false;

  let proj4: typeof import("proj4") | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    proj4 = require("proj4");
  } catch { /* ignore */ }

  const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
  const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

  type TurfPolygon = Feature<Polygon | MultiPolygon>;

  const toWgs84Feature = (f: GeoFeature): TurfPolygon | null => {
    try {
      if (f.geometry?.type !== "Polygon" && f.geometry?.type !== "MultiPolygon") return null;
      if (!coordsAreUtm) return f as unknown as TurfPolygon;
      if (!proj4) return f as unknown as TurfPolygon;

      const reprojectRing = (ring: number[][]): number[][] =>
        ring.map((pt) => proj4!(UTM28N, WGS84, [pt[0], pt[1]]));

      let geom: { type: string; coordinates: unknown };
      if (f.geometry.type === "Polygon") {
        geom = { type: "Polygon", coordinates: (f.geometry.coordinates as number[][][]).map(reprojectRing) };
      } else {
        geom = { type: "MultiPolygon", coordinates: (f.geometry.coordinates as number[][][][]).map((p) => p.map(reprojectRing)) };
      }
      return { type: "Feature", properties: f.properties, geometry: geom } as unknown as TurfPolygon;
    } catch { return null; }
  };

  const turfFeatures = overlapFeatures.map(toWgs84Feature);
  const turfBboxes: (BBox | null)[] = turfFeatures.map((f) => {
    try { return f ? (turf.bbox(f) as BBox) : null; } catch { return null; }
  });

  // Index spatial construit uniquement sur les bbox valides ; `validIdx[pos]`
  // retrouve l'index d'origine (dans `turfFeatures`/`overlapFeatures`) d'une
  // position dans l'index.
  const validIdx: number[] = [];
  const validBboxes: BBox[] = [];
  turfBboxes.forEach((bb, i) => {
    if (!bb) return;
    validIdx.push(i);
    validBboxes.push(bb);
  });
  const overlapIndex = new BBoxGridIndex(validBboxes);

  let overlapCount = 0;
  // Garde-fou contre un lot pathologique (ex. correction à l'ingestion
  // désactivée) plutôt qu'une vraie limite métier — un chevauchement réel
  // devrait rester rare après le retaillage fait à l'ingestion.
  const MAX_OVERLAP_ERRORS = 5000;

  outer:
  for (let pos = 0; pos < validIdx.length; pos++) {
    const i = validIdx[pos];
    const fA = turfFeatures[i];
    const bbA = validBboxes[pos];
    if (!fA) continue;

    for (const cand of overlapIndex.queryRange(bbA)) {
      const j = validIdx[cand];
      if (j <= i) continue;
      if (overlapCount >= MAX_OVERLAP_ERRORS) break outer;
      const fB = turfFeatures[j];
      const bbB = validBboxes[cand];
      if (!fB || !bboxIntersects(bbA, bbB)) continue;

      const propsA = overlapFeatures[i].properties || {};
      const propsB = overlapFeatures[j].properties || {};
      const nicadA = extractNicad(propsA) || `feature_${i}`;
      const nicadB = extractNicad(propsB) || `feature_${j}`;

      try {
        const intersection = turf.intersect(turf.featureCollection([fA, fB]));
        if (!intersection) continue;
        const overlapAreaM2 = turf.area(intersection);
        if (overlapAreaM2 < 0.01) continue;

        overlapCount++;
        nonConformeIdx.add(i);
        nonConformeIdx.add(j);
        const area1M2 = turf.area(fA);
        const area2M2 = turf.area(fB);
        const minArea = Math.min(area1M2, area2M2);
        const overlapPercent = minArea > 0 ? (overlapAreaM2 / minArea) * 100 : 0;
        const sev = overlapPercent > 50 ? "critical" : overlapPercent > 20 ? "high" : overlapPercent > 5 ? "medium" : "low";

        errors.push({
          type: "overlap",
          severity: sev,
          nicad1: nicadA,
          nicad2: nicadB,
          description: `Chevauchement RÉEL entre "${nicadA}" et "${nicadB}" : ${overlapAreaM2.toFixed(2)} m² (${overlapPercent.toFixed(1)}%)`,
          area: overlapAreaM2,
          confidence: 0.99,
          geometry: intersection.geometry,
        });
      } catch { /* ignore */ }
    }
  }

  // 3b. Gaps
  if (overlapFeatures.length >= 3 && overlapFeatures.length <= 300) {
    try {
      const validTurfFeatures = turfFeatures.filter((f): f is TurfPolygon => f !== null);
      if (validTurfFeatures.length >= 3) {
        let unionGeom: TurfPolygon = validTurfFeatures[0];
        for (let i = 1; i < Math.min(validTurfFeatures.length, 150); i++) {
          try {
            const u = turf.union(turf.featureCollection([unionGeom, validTurfFeatures[i]]));
            if (u) unionGeom = u as TurfPolygon;
          } catch { /* continue */ }
        }

        const fc = turf.featureCollection(validTurfFeatures);
        const hull = turf.convex(fc);
        if (hull) {
          const gapGeom = turf.difference(turf.featureCollection([hull as TurfPolygon, unionGeom]));
          if (gapGeom) {
            const gapAreaM2 = turf.area(gapGeom);
            if (gapAreaM2 > 1) {
              const gapCentroid = turf.centroid(gapGeom as TurfPolygon);
              const adjacentNicads: string[] = [];
              validTurfFeatures.slice(0, 30).forEach((f, idx) => {
                try {
                  const dist = turf.distance(gapCentroid, turf.centroid(f), { units: "meters" });
                  if (dist < 200) {
                    const props = overlapFeatures[idx]?.properties || {};
                    const nicad = extractNicad(props) || `feature_${idx}`;
                    if (nicad) adjacentNicads.push(nicad);
                  }
                } catch { /* ignore */ }
              });

              errors.push({
                type: "gap",
                severity: gapAreaM2 > 100 ? "high" : "medium",
                nicad1: adjacentNicads[0] || "gap",
                nicad2: adjacentNicads[1],
                description: `Espace vide (gap) de ${gapAreaM2.toFixed(2)} m² détecté. Parcelles adjacentes : ${adjacentNicads.slice(0, 5).join(", ") || "N/A"}`,
                area: gapAreaM2,
                confidence: 0.9,
                geometry: gapGeom.geometry,
              });
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 4. Admin boundary check
  if (adminBoundary && adminBoundary.features.length > 0) {
    const adminFeature = adminBoundary.features[0];
    const adminCoords = getPolygonCoords(adminFeature);
    if (adminCoords) {
      const adminBbox = getBBox(adminCoords);
      features.forEach((f, idx) => {
        const coords = getPolygonCoords(f);
        if (!coords) return;
        const bbox = getBBox(coords);
        const props = f.properties || {};
        const nicad = extractNicad(props) || `feature_${idx}`;
        if (bbox[0] < adminBbox[0] || bbox[1] < adminBbox[1] || bbox[2] > adminBbox[2] || bbox[3] > adminBbox[3]) {
          nonConformeIdx.add(idx);
          errors.push({
            type: "boundary_cross",
            severity: "high",
            nicad1: nicad,
            description: `Parcelle "${nicad}" dépasse les limites administratives`,
            confidence: 0.9,
            geometry: f.geometry,
          });
        }
      });
    }
  }

  // Conformity score
  const criticalErrors = errors.filter((e) => e.severity === "critical").length;
  const highErrors = errors.filter((e) => e.severity === "high").length;
  const mediumErrors = errors.filter((e) => e.severity === "medium").length;
  const totalPenalty = criticalErrors * 10 + highErrors * 5 + mediumErrors * 2;
  const conformityScore = Math.max(0, Math.min(100, 100 - (totalPenalty / Math.max(features.length, 1)) * 10));

  return {
    totalFeatures: features.length,
    errors,
    stats: {
      totalSurface,
      avgSurface: surfaces.length > 0 ? totalSurface / surfaces.length : 0,
      overlapCount: errors.filter((e) => e.type === "overlap").length,
      sliverCount: errors.filter((e) => e.type === "sliver").length,
      duplicateCount: errors.filter((e) => e.type === "duplicate").length,
      invalidCount: errors.filter((e) => e.type === "invalid_geom").length,
      missingNicadCount: errors.filter((e) => e.type === "missing_nicad").length,
      shortNicadErrorCount: errors.filter((e) => e.type === "short_nicad").length,
      conformeCount: Math.max(0, features.length - nonConformeIdx.size),
      nonConformeCount: nonConformeIdx.size,
      withNicadCount,
      withoutNicadCount,
      shortNicadCount,
      invalidLengthNicadCount,
      validNicad16Count,
      qgisControl: {
        totalParcelles: features.length,
        parcellesAvecNicad: withNicadCount,
        parcellesSansNicad: withoutNicadCount,
        nicadCourtMoins8: shortNicadCount,
        nicadLongueurDifferente16: invalidLengthNicadCount,
        nicadValide16: validNicad16Count,
      },
      conformityScore: Math.round(conformityScore * 10) / 10,
    },
  };
}

export async function generateAIReport(analysisResult: AnalysisResult, fileName: string): Promise<string> {
  const { totalFeatures, errors, stats } = analysisResult;

  // Build listDoublons: group duplicate errors by NICAD, collect all OBJECTIDs (stored in nicad2)
  const doublesMap = new Map<string, string[]>();
  for (const e of errors) {
    if (e.type === "duplicate" && e.nicad1) {
      if (!doublesMap.has(e.nicad1)) doublesMap.set(e.nicad1, []);
      if (e.nicad2) doublesMap.get(e.nicad1)!.push(e.nicad2);
    }
  }
  const listDoublons = Array.from(doublesMap.entries()).map(([nicad, objectids]) => ({
    nicad,
    objectids,
    occurrences: objectids.length,
  }));

  const factualData = {
    fichier: fileName,
    totalParcelles: totalFeatures,
    totalErreurs: errors.length,
    scoreConformite: stats.conformityScore,
    chevauchements: stats.overlapCount,
    slivers: stats.sliverCount,
    doublons: stats.duplicateCount,
    geometriesInvalides: stats.invalidCount,
    nicadManquants: stats.missingNicadCount,
    parcellesAvecNicad: stats.withNicadCount,
    parcellesSansNicad: stats.withoutNicadCount,
    nicadCourtMoins8: stats.shortNicadCount,
    nicadLongueurDifferente16: stats.invalidLengthNicadCount,
    nicadValide16: stats.validNicad16Count,
    erreursCritiques: errors.filter((e) => e.severity === "critical").length,
    erreursElevees: errors.filter((e) => e.severity === "high").length,
    topErreurs: errors.slice(0, 5).map((e) => ({
      type: e.type, severity: e.severity, nicad1: e.nicad1, description: e.description,
    })),
    listDoublons,
  };

  const { invokeLLM } = await import("./llm");

  try {
    return await invokeLLM({
      messages: [
        {
          role: "system",
          content: `Tu es un expert géomaticien et cadastral senior. Tu rédiges des rapports d'expertise basés UNIQUEMENT sur les données factuelles fournies. Structure en Markdown. Pas d'hallucinations.`,
        },
        {
          role: "user",
          content: `Rédige un rapport d'expertise cadastrale sur ces données: ${JSON.stringify(factualData, null, 2)}

Structure obligatoire:
1) Résumé Exécutif
2) Analyse des Erreurs
3) Duplications de données (NICAD / OBJECTID) — inclure un tableau Markdown avec colonnes NICAD | OBJECTIDs | Nb occurrences pour chaque entrée de listDoublons. Si listDoublons est vide, indiquer "Aucun doublon détecté."
4) Erreurs Prioritaires
5) Score de Conformité
6) Recommandations
7) Conclusion`,
        },
      ],
    });
  } catch {
    const doublesTable =
      listDoublons.length > 0
        ? `| NICAD | OBJECTIDs | Nb occurrences |\n|-------|-----------|----------------|\n` +
          listDoublons
            .map((d) => `| \`${d.nicad}\` | ${d.objectids.join(", ")} | ${d.occurrences} |`)
            .join("\n")
        : "_Aucun doublon détecté._";

    return `# Rapport d'Analyse Cadastrale - ${fileName}

## Résumé Exécutif
Analyse de **${totalFeatures} parcelles** terminée. **${errors.length} erreurs** détectées. Score de conformité : **${stats.conformityScore}%**.

## Statistiques
- Parcelles conformes : **${stats.conformeCount}** / ${totalFeatures}
- Chevauchements : **${stats.overlapCount}**
- Résidus (Slivers) : **${stats.sliverCount}**
- Doublons NICAD : **${stats.duplicateCount}**
- Géométries invalides : **${stats.invalidCount}**
- NICAD manquants : **${stats.missingNicadCount}**
- NICAD trop courts (< 8 car.) : **${stats.shortNicadCount}**
- NICAD valides 16 chars : **${stats.validNicad16Count}**

## Duplications de données (NICAD / OBJECTID)

${doublesTable}

## Recommandations
1. Corriger les ${errors.filter((e) => e.severity === "critical").length} erreurs critiques en priorité
2. Traiter les ${errors.filter((e) => e.severity === "high").length} erreurs élevées
3. Valider tous les NICAD manquants ou dupliqués`;
  }
}
