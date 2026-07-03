import { NextRequest, NextResponse } from "next/server";
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { extractNicad } from "@/lib/geo-engine";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Params = Promise<{ id: string }>;

type GeoFeature = { type: "Feature"; geometry: any; properties: Record<string, unknown> | null };
type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };
type BBox = [number, number, number, number];

/**
 * Localisateur d'une parcelle à supprimer, du plus précis au moins précis :
 *  - `point` [lng, lat] : coordonnée intérieure (clic carte) → point-dans-polygone ;
 *  - `bbox` [w, s, e, n] : emprise (occurrence d'un groupe NICAD) → appariement d'emprise ;
 *  - `nicad` : repli (première parcelle portant ce NICAD).
 */
type Locator = { point?: [number, number]; bbox?: BBox; nicad?: string };

const isPolygonal = (f?: GeoFeature): boolean =>
  f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

function featureBBox(f: GeoFeature): BBox | null {
  try {
    return turf.bbox(f as any) as BBox;
  } catch {
    return null;
  }
}

const bboxL1 = (a: BBox, b: BBox): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);

/** Résout un localisateur en index de feature dans le GeoJSON, ou -1. */
function resolveLocator(features: GeoFeature[], loc: Locator, taken: Set<number>): number {
  // 1. Point intérieur (le plus fiable) : parcelle contenant le point.
  if (loc.point && Number.isFinite(loc.point[0]) && Number.isFinite(loc.point[1])) {
    const pt = turf.point(loc.point);
    for (let i = 0; i < features.length; i++) {
      if (taken.has(i) || !isPolygonal(features[i])) continue;
      try {
        if (turf.booleanPointInPolygon(pt, features[i] as any)) return i;
      } catch {
        /* géométrie non testable : ignorer */
      }
    }
  }

  // 2. Emprise (occurrence précise d'un NICAD dupliqué).
  if (loc.bbox) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < features.length; i++) {
      if (taken.has(i)) continue;
      const b = featureBBox(features[i]);
      if (!b) continue;
      const d = bboxL1(b, loc.bbox);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD < 1e-5) return best;
  }

  // 3. NICAD (repli, première occurrence libre).
  if (loc.nicad) {
    for (let i = 0; i < features.length; i++) {
      if (taken.has(i)) continue;
      if (extractNicad(features[i].properties) === loc.nicad) return i;
    }
  }

  return -1;
}

/**
 * POST /api/analyses/[id]/features/delete
 *
 * Supprime des parcelles de l'analyse depuis la table attributaire. Chaque
 * parcelle est identifiée par un localisateur (point intérieur, emprise ou
 * NICAD). L'édition est écrite dans `correctedData` (source lue par les tuiles
 * vectorielles), de façon cohérente avec le flux de correction des erreurs. Les
 * erreurs de topologie dont l'index est fourni sont marquées corrigées.
 */
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return NextResponse.json({ error: "ID d'analyse invalide" }, { status: 400 });
  }

  let body: { locators?: Locator[]; errorIds?: number[] } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const locators = Array.isArray(body.locators) ? body.locators : [];
  if (locators.length === 0) {
    return NextResponse.json({ error: "Aucune parcelle à supprimer" }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  // Prime les corrections déjà appliquées, sinon le GeoJSON persisté sur disque,
  // sinon le champ inline (legacy) — même priorité que la route de correction.
  const rawGeoJson =
    analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!rawGeoJson) return NextResponse.json({ error: "GeoJSON introuvable" }, { status: 400 });

  let geoJson: GeoFC;
  try {
    geoJson = JSON.parse(rawGeoJson);
  } catch {
    return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 });
  }

  const features = geoJson.features ?? [];
  const removed = new Set<number>();
  const notFound: Locator[] = [];
  for (const loc of locators) {
    const idx = resolveLocator(features, loc, removed);
    if (idx >= 0) removed.add(idx);
    else notFound.push(loc);
  }

  if (removed.size === 0) {
    return NextResponse.json(
      { error: "Parcelle(s) introuvable(s) dans le GeoJSON", notFound },
      { status: 404 }
    );
  }

  geoJson.features = features.filter((_, i) => !removed.has(i));
  const correctedGeoJson = JSON.stringify(geoJson);
  const errorIds = (body.errorIds ?? []).filter((n) => Number.isInteger(n));

  await prisma.$transaction([
    prisma.analysis.update({
      where: { id: analysisId },
      data: { correctedData: correctedGeoJson, totalFeatures: geoJson.features.length },
    }),
    ...(errorIds.length > 0
      ? [
          prisma.topologicalError.updateMany({
            where: { analysisId, id: { in: errorIds } },
            data: { corrected: true },
          }),
        ]
      : []),
  ]);

  // Persiste aussi le GeoJSON de base (clé disque) quand il existe, pour que les
  // recalculs repartant de la source reflètent les suppressions. Hors transaction
  // (le store fichier n'est pas transactionnel) ; `correctedData` fait foi pour
  // l'affichage, on n'échoue donc pas l'appel si l'écriture disque échoue.
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  return NextResponse.json({
    success: true,
    deleted: removed.size,
    remaining: geoJson.features.length,
    notFound: notFound.length,
    correctedGeoJson,
  });
}
