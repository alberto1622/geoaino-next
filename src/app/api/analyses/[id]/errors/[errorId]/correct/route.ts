import { NextRequest, NextResponse } from "next/server";
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";
import { extractNicad, type GeoFeature as GeoEngineFeature } from "@/lib/geo-engine";
import { findBestNeighborMerge } from "@/lib/sliver-correction";
import { requireSession } from "@/lib/analyses/require-session";
import { setFeatureSection } from "@/lib/analyses/feature-locator";
import {
  buildNicad,
  normalizeSection,
  normalizeNumeroParcelle,
  digitsOnly,
  NICAD_PREFIX_LENGTH,
  NICAD_SECTION_LENGTH,
  NICAD_PARCELLE_LENGTH,
  NICAD_TOTAL_LENGTH,
} from "@/lib/nicad";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Params = Promise<{ id: string; errorId: string }>;

type GeoFeature = { type: "Feature"; geometry: any; properties: Record<string, unknown> | null };
type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

const ACTIONS_BY_TYPE: Record<string, string[]> = {
  OVERLAP: ["clip_first", "clip_second", "ignore"],
  SLIVER: ["merge_neighbor", "delete", "ignore"],
  GAP: ["assign_to_neighbor", "ignore"],
  BOUNDARY_CROSS: ["truncate", "ignore"],
  INVALID_GEOM: ["delete", "ignore"],
  DUPLICATE: ["delete", "ignore"],
  MISSING_NICAD: ["assign_nicad", "ignore"],
  SHORT_NICAD: ["assign_nicad", "ignore"],
  SECTION_MISMATCH: ["assign_section", "ignore"],
  MULTI_NUMERO: ["choose_numero", "ignore"],
};

// Poids de pénalité par sévérité — même barème que `geo-engine.ts ·
// analyzeGeoJSON` (`totalPenalty = critical*10 + high*5 + medium*2`), utilisé
// pour patcher `conformityScore` de façon incrémentale après CETTE erreur
// (cf. le patch équivalent, poids fixe "critical", dans `nicad-fill-missing.ts`).
const SEVERITY_PENALTY: Record<string, number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 0 };

// Surface planaire (shoelace) dans le système de coordonnées natif — sert
// uniquement à classer les chevauchements, indépendamment du CRS (UTM ou WGS84).
function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}
function planarArea(geom: any): number {
  try {
    if (geom.type === "Polygon") return ringArea(geom.coordinates[0]);
    if (geom.type === "MultiPolygon") return (geom.coordinates as number[][][][]).reduce((s, p) => s + ringArea(p[0]), 0);
  } catch { /* ignore */ }
  return 0;
}

const isPolygonal = (f?: GeoFeature): boolean =>
  f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

const bboxesDisjoint = (a: number[], b: number[]): boolean =>
  a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];

// Trouve la parcelle qui chevauche le plus `features[knownIdx]` (préfiltre bbox).
// Utilisé pour retrouver le partenaire d'un OVERLAP quand son NICAD est absent
// (identifiant `feature_<idx>` non résoluble par NICAD).
function findOverlapPartner(features: GeoFeature[], knownIdx: number, exclude: number[]): number {
  const known = features[knownIdx];
  if (!isPolygonal(known)) return -1;
  let kb: number[];
  try { kb = turf.bbox(known as any); } catch { return -1; }
  let best = -1, bestArea = 0;
  for (let i = 0; i < features.length; i++) {
    if (i === knownIdx || exclude.includes(i)) continue;
    const f = features[i];
    if (!isPolygonal(f)) continue;
    let fb: number[];
    try { fb = turf.bbox(f as any); } catch { continue; }
    if (bboxesDisjoint(kb, fb)) continue;
    try {
      const inter = turf.intersect(turf.featureCollection([known as any, f as any]));
      if (!inter) continue;
      const area = planarArea(inter.geometry);
      if (area > bestArea) { bestArea = area; best = i; }
    } catch { /* ignore */ }
  }
  return best;
}

// Classe les parcelles par surface de chevauchement avec une géométrie donnée
// (cas extrême : les deux parcelles de l'OVERLAP sont sans NICAD).
function findFeaturesOverlappingGeometry(features: GeoFeature[], geometry: unknown, n: number): number[] {
  if (!geometry) return [];
  let gb: number[];
  const geomFeature = turf.feature(geometry as any);
  try { gb = turf.bbox(geomFeature); } catch { return []; }
  const scored: Array<{ idx: number; area: number }> = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (!isPolygonal(f)) continue;
    let fb: number[];
    try { fb = turf.bbox(f as any); } catch { continue; }
    if (bboxesDisjoint(gb, fb)) continue;
    try {
      const inter = turf.intersect(turf.featureCollection([geomFeature as any, f as any]));
      if (!inter) continue;
      const area = planarArea(inter.geometry);
      if (area > 0) scored.push({ idx: i, area });
    } catch { /* ignore */ }
  }
  return scored.sort((a, b) => b.area - a.area).slice(0, n).map((s) => s.idx);
}

function coordsApproxEqual(a: unknown, b: unknown, eps = 1e-7): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < eps;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => coordsApproxEqual(v, b[i], eps));
  }
  return false;
}

function geometryApproxEqual(g1: any, g2: any): boolean {
  if (!g1 || !g2 || g1.type !== g2.type) return false;
  return coordsApproxEqual(g1.coordinates, g2.coordinates);
}

function findFeatureIndex(features: GeoFeature[], nicad: string, fallbackGeometry?: unknown): number {
  const idx = features.findIndex((f) => extractNicad(f.properties) === nicad);
  if (idx !== -1) return idx;

  // "feature_N" identifiers are positional and become stale once earlier
  // corrections remove features (shifting all subsequent indices). Fall back
  // to matching the feature whose geometry matches the one stored on the error
  // (numeric values may differ slightly after a jsonb round-trip, hence the tolerance).
  if (nicad.startsWith("feature_") && fallbackGeometry) {
    return features.findIndex((f) => geometryApproxEqual(f.geometry, fallbackGeometry));
  }
  return -1;
}

// Localise une feature par sa géométrie (utilisée pour les erreurs sans NICAD
// fiable : INVALID_GEOM, MISSING_NICAD, ou une occurrence précise de DUPLICATE).
function findFeatureIndexByGeometry(features: GeoFeature[], geometry: unknown): number {
  if (!geometry) return -1;
  return features.findIndex((f) => geometryApproxEqual(f.geometry, geometry));
}

// Génère un NICAD AUTO_xxxxxx non encore utilisé dans le jeu de données.
function generateAutoNicad(features: GeoFeature[]): string {
  let max = 0;
  for (const f of features) {
    const n = extractNicad(f.properties);
    const m = /^AUTO_(\d+)$/.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `AUTO_${String(max + 1).padStart(6, "0")}`;
}

export async function POST(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id, errorId } = await params;
  const analysisId = parseInt(id);
  const errorIdNum = parseInt(errorId);

  let body: { action?: string; targetNicad?: string; targetSection?: string; targetNumero?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = body.action;

  const error = await prisma.topologicalError.findFirst({ where: { id: errorIdNum, analysisId } });
  if (!error) return NextResponse.json({ error: "Erreur non trouvée" }, { status: 404 });
  if (error.corrected) return NextResponse.json({ error: "Erreur déjà corrigée" }, { status: 400 });

  const allowedActions = ACTIONS_BY_TYPE[error.errorType];
  if (!allowedActions || !action || !allowedActions.includes(action)) {
    return NextResponse.json({ error: `Action invalide pour le type d'erreur ${error.errorType}` }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  let resultGeometry: unknown = null;
  let message = "Erreur marquée comme intentionnelle";
  let geoJson: GeoFC | null = null;

  if (action !== "ignore") {
    const rawGeoJson =
      analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
    if (!rawGeoJson) return NextResponse.json({ error: "GeoJSON introuvable" }, { status: 400 });
    try { geoJson = JSON.parse(rawGeoJson); } catch { return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 }); }

    const features = geoJson!.features;
    let removedIndex = -1;

    if (error.errorType === "OVERLAP" && (action === "clip_first" || action === "clip_second")) {
      // Résolution robuste des deux parcelles : par NICAD quand il est réel,
      // sinon (identifiant `feature_<idx>`) par chevauchement géométrique — les
      // index positionnels deviennent périmés après des suppressions antérieures.
      const idxByRealNicad = (nic?: string | null): number =>
        nic && !nic.startsWith("feature_") ? features.findIndex((f) => extractNicad(f.properties) === nic) : -1;

      let idx1 = idxByRealNicad(error.nicad1);
      let idx2 = idxByRealNicad(error.nicad2);

      if (idx1 !== -1 && idx2 === -1) {
        idx2 = findOverlapPartner(features, idx1, [idx1]);
      } else if (idx2 !== -1 && idx1 === -1) {
        idx1 = findOverlapPartner(features, idx2, [idx2]);
      } else if (idx1 === -1 && idx2 === -1) {
        const cand = findFeaturesOverlappingGeometry(features, error.geometry, 2);
        idx1 = cand[0] ?? -1;
        idx2 = cand[1] ?? -1;
      }

      if (idx1 === -1 || idx2 === -1) {
        return NextResponse.json({ error: "Parcelle(s) du chevauchement introuvable(s) dans le GeoJSON" }, { status: 404 });
      }

      const targetIdx = action === "clip_first" ? idx1 : idx2;
      const otherIdx = action === "clip_first" ? idx2 : idx1;
      const targetNicad = extractNicad(features[targetIdx].properties) || (action === "clip_first" ? error.nicad1 : error.nicad2) || "parcelle";
      const otherNicad = extractNicad(features[otherIdx].properties) || (action === "clip_first" ? error.nicad2 : error.nicad1) || "parcelle";

      const diff = turf.difference(turf.featureCollection([features[targetIdx] as any, features[otherIdx] as any]));
      if (!diff) {
        removedIndex = targetIdx;
        message = `Parcelle ${targetNicad} entièrement couverte par ${otherNicad} — supprimée`;
      } else {
        features[targetIdx] = { ...features[targetIdx], geometry: diff.geometry };
        resultGeometry = diff.geometry;
        message = `Parcelle ${targetNicad} découpée pour résoudre le chevauchement avec ${otherNicad}`;
      }
    } else if (error.errorType === "SLIVER" && action === "merge_neighbor") {
      const sliverNicad = error.nicad1;
      if (!sliverNicad) return NextResponse.json({ error: "NICAD manquant pour cette erreur" }, { status: 400 });
      const sliverIdx = findFeatureIndex(features, sliverNicad, error.geometry);
      if (sliverIdx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });

      // Rattachement à la parcelle adjacente appropriée : voisin partageant la
      // plus longue frontière commune (cf. src/lib/sliver-correction.ts).
      const merge = findBestNeighborMerge(features as unknown as GeoEngineFeature[], sliverIdx);
      if (!merge) return NextResponse.json({ error: "Aucune parcelle adjacente trouvée pour ce sliver" }, { status: 400 });

      features[merge.neighborIdx] = { ...features[merge.neighborIdx], geometry: merge.mergedGeometry };
      removedIndex = sliverIdx;
      resultGeometry = merge.mergedGeometry;
      message = `Sliver ${sliverNicad} rattaché à la parcelle voisine ${merge.neighborNicad}` +
        (merge.byOverlap ? " (plus grande surface adjacente)" : ` (frontière commune ${merge.sharedLengthM.toFixed(2)} m)`);
    } else if (error.errorType === "SLIVER" && action === "delete") {
      const sliverNicad = error.nicad1;
      if (!sliverNicad) return NextResponse.json({ error: "NICAD manquant pour cette erreur" }, { status: 400 });
      const sliverIdx = findFeatureIndex(features, sliverNicad, error.geometry);
      if (sliverIdx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
      removedIndex = sliverIdx;
      message = `Sliver ${sliverNicad} supprimé`;
    } else if (error.errorType === "GAP" && action === "assign_to_neighbor") {
      const targetNicad = body.targetNicad || error.nicad1;
      if (!targetNicad) return NextResponse.json({ error: "Aucune parcelle adjacente connue pour ce gap" }, { status: 400 });
      const targetIdx = findFeatureIndex(features, targetNicad);
      if (targetIdx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
      if (!error.geometry) return NextResponse.json({ error: "Géométrie du gap manquante" }, { status: 400 });

      const gapFeature = turf.feature(error.geometry as any);
      const union = turf.union(turf.featureCollection([gapFeature as any, features[targetIdx] as any]));
      if (!union) return NextResponse.json({ error: "Fusion impossible" }, { status: 400 });
      features[targetIdx] = { ...features[targetIdx], geometry: union.geometry };
      resultGeometry = union.geometry;
      message = `Espace vide rattaché à la parcelle ${targetNicad}`;
    } else if (error.errorType === "BOUNDARY_CROSS" && action === "truncate") {
      const targetNicad = error.nicad1;
      if (!targetNicad) return NextResponse.json({ error: "NICAD manquant pour cette erreur" }, { status: 400 });
      const targetIdx = findFeatureIndex(features, targetNicad, error.geometry);
      if (targetIdx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
      if (!analysis.adminBoundaryData) return NextResponse.json({ error: "Limite administrative non disponible" }, { status: 400 });

      let boundaryFc: GeoFC;
      try { boundaryFc = JSON.parse(analysis.adminBoundaryData); } catch { return NextResponse.json({ error: "Limite administrative invalide" }, { status: 400 }); }
      const boundaryFeature = boundaryFc.features?.[0];
      if (!boundaryFeature) return NextResponse.json({ error: "Limite administrative vide" }, { status: 400 });

      const intersection = turf.intersect(turf.featureCollection([features[targetIdx] as any, boundaryFeature as any]));
      if (!intersection) return NextResponse.json({ error: "Aucune intersection avec la limite administrative" }, { status: 400 });
      features[targetIdx] = { ...features[targetIdx], geometry: intersection.geometry };
      resultGeometry = intersection.geometry;
      message = `Parcelle ${targetNicad} tronquée à la limite administrative`;
    } else if (error.errorType === "INVALID_GEOM" && action === "delete") {
      let idx = error.nicad1 ? findFeatureIndex(features, error.nicad1, error.geometry) : -1;
      if (idx === -1) idx = findFeatureIndexByGeometry(features, error.geometry);
      if (idx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
      removedIndex = idx;
      message = `Géométrie invalide ${error.nicad1 ?? ""} supprimée`.trim();
    } else if (error.errorType === "DUPLICATE" && action === "delete") {
      // Supprime l'occurrence précise du doublon (localisée par sa géométrie),
      // en conservant les autres parcelles portant le même NICAD.
      const idx = findFeatureIndexByGeometry(features, error.geometry);
      if (idx === -1) return NextResponse.json({ error: "Occurrence du doublon introuvable dans le GeoJSON" }, { status: 404 });
      removedIndex = idx;
      message = `Doublon NICAD ${error.nicad1 ?? ""} supprimé`.trim();
    } else if ((error.errorType === "MISSING_NICAD" || error.errorType === "SHORT_NICAD") && action === "assign_nicad") {
      const idx = findFeatureIndexByGeometry(features, error.geometry);
      if (idx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
      const provided = body.targetNicad?.trim();
      const newNicad = provided && provided.length > 0 ? provided : generateAutoNicad(features);
      features[idx] = {
        ...features[idx],
        properties: { ...(features[idx].properties ?? {}), nicad: newNicad, _autoAssigned: !provided },
      };
      message = `NICAD "${newNicad}" assigné à la parcelle`;
    } else if (error.errorType === "SECTION_MISMATCH" && action === "assign_section") {
      const idx = findFeatureIndexByGeometry(features, error.geometry);
      if (idx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });

      const geolocated = digitsOnly(features[idx].properties?.sectionGeolocalisee);
      const provided = body.targetSection?.trim();
      const newSection = normalizeSection(provided || geolocated.slice(-NICAD_SECTION_LENGTH));
      if (!newSection) return NextResponse.json({ error: "Numéro de section invalide" }, { status: 400 });

      // `numero_section` (clé canonique lue par la classification « sans
      // section », cf. tile-index.ts · _ssec) sur toutes ses clés porteuses.
      setFeatureSection(features[idx], newSection);

      // Recompose `codeSection` (11 chiffres) à partir du préfixe syscol déjà
      // résolu par la jointure spatiale (`sectionGeolocalisee`, cf.
      // assign-section-nicad.ts) pour rester cohérent avec la nouvelle section.
      if (geolocated.length >= NICAD_PREFIX_LENGTH) {
        features[idx].properties = {
          ...(features[idx].properties ?? {}),
          codeSection: `${geolocated.slice(0, NICAD_PREFIX_LENGTH)}${newSection}`,
        };
      }

      // Si la parcelle a déjà un NICAD complet, resynchronise son segment
      // section pour rester cohérent — même logique que nicad-section-sync.ts.
      const currentNicad = extractNicad(features[idx].properties);
      if (currentNicad && currentNicad.length === NICAD_TOTAL_LENGTH) {
        const rebuiltNicad = buildNicad(
          currentNicad.slice(0, NICAD_PREFIX_LENGTH),
          newSection,
          currentNicad.slice(-NICAD_PARCELLE_LENGTH),
        );
        if (rebuiltNicad && rebuiltNicad !== currentNicad) {
          features[idx].properties = { ...(features[idx].properties ?? {}), nicad: rebuiltNicad };
        }
      }

      message = `Section corrigée à "${newSection}" pour la parcelle`;
    } else if (error.errorType === "MULTI_NUMERO" && action === "choose_numero") {
      const idx = findFeatureIndexByGeometry(features, error.geometry);
      if (idx === -1) return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });

      // Candidats posés par `analyzeGeoJSON` dans `nicad2` (pas de champ dédié
      // sur `TopologicalError` pour cette liste — cf. commentaire geo-engine.ts).
      const candidats = (error.nicad2 ?? "").split("|").map((c) => c.trim()).filter(Boolean);
      const chosen = body.targetNumero?.trim();
      if (!chosen || (candidats.length > 0 && !candidats.includes(chosen))) {
        return NextResponse.json(
          { error: `Numéro invalide — attendu l'un de : ${candidats.join(", ")}` },
          { status: 400 },
        );
      }

      const numero5 = normalizeNumeroParcelle(chosen);
      features[idx].properties = {
        ...(features[idx].properties ?? {}),
        numero: chosen,
        numero_parcelle: numero5.value,
        // Ambiguïté résolue : un seul candidat désormais, sans quoi une
        // régénération du rapport re-détecterait la même erreur.
        numero_candidats: [chosen],
      };

      // Si la parcelle a déjà un NICAD complet, resynchronise son segment
      // parcelle pour rester cohérent — même principe que SECTION_MISMATCH
      // ci-dessus pour le segment section.
      const currentNicad = extractNicad(features[idx].properties);
      if (currentNicad && currentNicad.length === NICAD_TOTAL_LENGTH && numero5.value) {
        const rebuiltNicad = buildNicad(
          currentNicad.slice(0, NICAD_PREFIX_LENGTH),
          currentNicad.slice(NICAD_PREFIX_LENGTH, NICAD_PREFIX_LENGTH + NICAD_SECTION_LENGTH),
          numero5.value,
        );
        if (rebuiltNicad && rebuiltNicad !== currentNicad) {
          features[idx].properties = { ...(features[idx].properties ?? {}), nicad: rebuiltNicad };
        }
      }

      message = `Numéro "${chosen}" conservé pour la parcelle`;
    } else {
      return NextResponse.json({ error: `Action "${action}" non supportée pour le type d'erreur ${error.errorType}` }, { status: 400 });
    }

    geoJson!.features = removedIndex === -1 ? features : features.filter((_, i) => i !== removedIndex);
  }

  const correctedGeoJson = geoJson ? JSON.stringify(geoJson) : analysis.correctedData ?? analysis.geoJsonData;

  // Patch incrémental `errorCount`/`conformityScore` — sinon ces deux champs
  // restent figés à l'état du dernier calcul complet (import ou « Régénérer le
  // rapport ») et l'écran `/map/[analysisId]` continue d'afficher un score
  // périmé après une correction, même après rechargement de page (même
  // problème que réglé par `nicad-fill-missing.ts · patchAnalysisStatsAfterNicadFill`
  // pour l'attribution en masse de NICAD, généralisé ici à la sévérité réelle
  // de l'erreur au lieu du poids fixe "critical").
  const totalFeatures = analysis.totalFeatures ?? 0;
  const weight = SEVERITY_PENALTY[error.severity?.toUpperCase()] ?? 0;
  const prevScore = Number(analysis.conformityScore) || 0;
  const newScore =
    totalFeatures > 0 && weight > 0
      ? Math.max(0, Math.min(100, Math.round((prevScore + (weight / totalFeatures) * 10) * 10) / 10))
      : prevScore;
  const newErrorCount = Math.max(0, (analysis.errorCount ?? 0) - 1);

  await prisma.$transaction([
    prisma.analysis.update({
      where: { id: analysisId },
      data: {
        ...(geoJson ? { correctedData: correctedGeoJson } : {}),
        errorCount: newErrorCount,
        conformityScore: newScore.toString(),
      },
    }),
    prisma.topologicalError.update({
      where: { id: errorIdNum },
      data: {
        corrected: true,
        ...(resultGeometry ? { correctionGeometry: resultGeometry as any } : {}),
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    action,
    message,
    correctedGeoJson,
    stats: { errorCount: newErrorCount, conformityScore: newScore },
  });
}
