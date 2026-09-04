import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import * as turf from "@turf/turf";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { resolveLocator, type GeoFeature, type Locator } from "@/lib/analyses/feature-locator";
import { recordHistory, type MapEditSnapshot } from "@/lib/cadastre/history";

type Params = Promise<{ id: string }>;

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };
type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

const isPolygonal = (g: unknown): g is PolyGeom =>
  (g as { type?: string })?.type === "Polygon" || (g as { type?: string })?.type === "MultiPolygon";

/** Concatène les anneaux en MultiPolygon — repli si `turf.union` échoue (même
 * stratégie que `sections/merge`, aucun fragment perdu). */
function concatAsMultiPolygon(geoms: PolyGeom[]): GeoJSON.MultiPolygon {
  const coordinates: GeoJSON.Position[][][] = [];
  for (const g of geoms) {
    if (g.type === "Polygon") coordinates.push(g.coordinates);
    else coordinates.push(...g.coordinates);
  }
  return { type: "MultiPolygon", coordinates };
}

/**
 * POST /api/analyses/[id]/features/merge — fusion manuelle de 2+ parcelles de
 * la table attributaire (recoller une parcelle scindée à tort par une limite
 * parasite ; PAS destiné à fusionner deux parcelles réellement distinctes).
 *
 * Chaque parcelle est identifiée par un localisateur (point intérieur, emprise
 * ou NICAD), même contrat que `features/delete`. La PREMIÈRE résolue (ordre de
 * `locators` = ordre de sélection côté client) conserve toutes ses propriétés
 * (NICAD, numéro, commune…) ; sa géométrie devient l'union de l'ensemble. Les
 * autres parcelles résolues sont retirées du GeoJSON.
 *
 * Édition écrite dans `correctedData` (source des tuiles vectorielles), même
 * flux que la correction/suppression de parcelle. Capture l'état AVANT édition
 * et l'enregistre comme entrée d'historique restaurable, dans la même
 * transaction que l'écriture — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return NextResponse.json({ error: "ID d'analyse invalide" }, { status: 400 });
  }

  let body: { locators?: Locator[]; errorIds?: number[] } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const locators = Array.isArray(body.locators) ? body.locators : [];
  if (locators.length < 2) {
    return NextResponse.json({ error: "Au moins 2 parcelles requises pour une fusion" }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  // Même priorité de lecture que features/delete et update-nicad.
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
  const resolved: number[] = [];
  const taken = new Set<number>();
  const notFound: Locator[] = [];
  for (const loc of locators) {
    const idx = resolveLocator(features, loc, taken);
    if (idx >= 0) {
      resolved.push(idx);
      taken.add(idx);
    } else {
      notFound.push(loc);
    }
  }

  const polygonal = resolved.filter((i) => isPolygonal(features[i]?.geometry));
  if (polygonal.length < 2) {
    return NextResponse.json(
      { error: "Au moins 2 parcelles polygonales localisables requises", notFound },
      { status: 404 },
    );
  }

  const keptIdx = polygonal[0];
  const geoms = polygonal.map((i) => features[i].geometry as PolyGeom);
  let merged: PolyGeom;
  try {
    const u = turf.union(turf.featureCollection(geoms.map((g) => turf.feature(g))));
    merged = (u?.geometry as PolyGeom | undefined) ?? concatAsMultiPolygon(geoms);
  } catch {
    merged = concatAsMultiPolygon(geoms);
  }

  const removed = new Set(polygonal.slice(1));
  const keptFeature: GeoFeature = { ...features[keptIdx], geometry: merged };
  geoJson.features = features
    .map((f, i) => (i === keptIdx ? keptFeature : f))
    .filter((_, i) => !removed.has(i));
  const correctedGeoJson = JSON.stringify(geoJson);
  const errorIds = (body.errorIds ?? []).filter((n) => Number.isInteger(n));

  await prisma.$transaction(async (tx) => {
    const priorErrors =
      errorIds.length > 0
        ? await tx.topologicalError.findMany({
            where: { analysisId, id: { in: errorIds } },
            select: { id: true, corrected: true },
          })
        : [];

    await tx.analysis.update({
      where: { id: analysisId },
      data: { correctedData: correctedGeoJson, totalFeatures: geoJson.features.length },
    });
    if (errorIds.length > 0) {
      await tx.topologicalError.updateMany({
        where: { analysisId, id: { in: errorIds } },
        data: { corrected: true },
      });
    }

    const before: MapEditSnapshot = {
      correctedGeoJson: rawGeoJson,
      errorPatches: priorErrors.map((e) => ({ errorId: e.id, corrected: e.corrected })),
    };
    const after: MapEditSnapshot = {
      correctedGeoJson,
      errorPatches: errorIds.map((eid) => ({ errorId: eid, corrected: true })),
    };
    await recordHistory(tx, {
      scope: "map",
      scopeKey: String(analysisId),
      action: "map-merge",
      summary: `Fusion de ${polygonal.length} parcelle(s) sur l'analyse #${analysisId}`,
      before,
      after,
      createdBy,
    });
  }, { maxWait: 10_000, timeout: 120_000 });

  // Persiste aussi le GeoJSON de base (clé disque) quand il existe — hors
  // transaction (store fichier non transactionnel), `correctedData` fait foi
  // pour l'affichage donc on n'échoue pas l'appel si l'écriture disque échoue.
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  return NextResponse.json({
    success: true,
    merged: polygonal.length,
    remaining: geoJson.features.length,
    notFound: notFound.length,
    correctedGeoJson,
    // Blob exact d'avant édition (historique client annuler/rétablir) — `rawGeoJson`
    // n'a pas été muté, seul l'objet `geoJson` parsé l'a été.
    previousCorrectedGeoJson: rawGeoJson,
  });
}
