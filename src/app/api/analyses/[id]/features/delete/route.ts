import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { resolveLocator, type GeoFeature, type Locator } from "@/lib/analyses/feature-locator";
import { requireSession } from "@/lib/analyses/require-session";

type Params = Promise<{ id: string }>;

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

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
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

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
    // Blob exact d'avant édition (utilisé par l'historique annuler/rétablir côté
    // client) : `rawGeoJson` n'a pas été muté, seul l'objet `geoJson` parsé l'a été.
    previousCorrectedGeoJson: rawGeoJson,
  });
}
