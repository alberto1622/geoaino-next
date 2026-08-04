import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeGeoJsonByKey } from "@/lib/geo-storage";
import { requireSession } from "@/lib/analyses/require-session";

type Params = Promise<{ id: string }>;

type ErrorPatch = { errorId: number; corrected: boolean };

/**
 * POST /api/analyses/[id]/history/restore
 *
 * Réécrit `correctedData` avec un blob GeoJSON déjà connu du client (capturé
 * avant une édition, ou reçu en réponse d'une édition) et remet les flags
 * `corrected` des erreurs listées à l'état qu'elles avaient à ce moment.
 * Utilisé par l'historique annuler/rétablir de la table attributaire : on lui
 * passe le blob « avant » pour annuler une édition, le blob « après » pour la
 * rétablir — la même route sert les deux sens.
 */
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return NextResponse.json({ error: "ID d'analyse invalide" }, { status: 400 });
  }

  let body: { correctedGeoJson?: string; errorPatches?: ErrorPatch[] } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const correctedGeoJson = body.correctedGeoJson;
  if (typeof correctedGeoJson !== "string") {
    return NextResponse.json({ error: "correctedGeoJson requis" }, { status: 400 });
  }
  const errorPatches = Array.isArray(body.errorPatches) ? body.errorPatches : [];

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  let geoJson: { features?: unknown[] };
  try {
    geoJson = JSON.parse(correctedGeoJson);
  } catch {
    return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 });
  }
  const totalFeatures = Array.isArray(geoJson.features) ? geoJson.features.length : undefined;

  const correctedIds = errorPatches.filter((p) => p.corrected).map((p) => p.errorId);
  const uncorrectedIds = errorPatches.filter((p) => !p.corrected).map((p) => p.errorId);

  await prisma.$transaction([
    prisma.analysis.update({
      where: { id: analysisId },
      data: { correctedData: correctedGeoJson, ...(totalFeatures != null ? { totalFeatures } : {}) },
    }),
    ...(correctedIds.length > 0
      ? [
          prisma.topologicalError.updateMany({
            where: { analysisId, id: { in: correctedIds } },
            data: { corrected: true },
          }),
        ]
      : []),
    ...(uncorrectedIds.length > 0
      ? [
          prisma.topologicalError.updateMany({
            where: { analysisId, id: { in: uncorrectedIds } },
            data: { corrected: false },
          }),
        ]
      : []),
  ]);

  // Même logique que les routes d'édition : la source disque suit `correctedData`
  // mais n'est pas bloquante si l'écriture échoue.
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  return NextResponse.json({ success: true, correctedGeoJson });
}
