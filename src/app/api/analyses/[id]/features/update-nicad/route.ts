import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import {
  resolveLocator,
  setFeatureNicad,
  type GeoFeature,
  type Locator,
} from "@/lib/analyses/feature-locator";
import { recordHistory, type MapEditSnapshot } from "@/lib/cadastre/history";

type Params = Promise<{ id: string }>;

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

/**
 * POST /api/analyses/[id]/features/update-nicad
 *
 * Réassigne le NICAD d'UNE parcelle (localisée par point/emprise/NICAD, cf.
 * `feature-locator`). Sert à résoudre une doublure en donnant un NICAD distinct à
 * l'occurrence sélectionnée, sans la supprimer. L'édition transite par
 * `correctedData` (source des tuiles) comme le reste du flux d'édition ; si un
 * `errorId` (erreur DUPLICATE de cette occurrence) est fourni, il est marqué
 * corrigé.
 *
 * Capture l'état AVANT édition (GeoJSON + statut `corrected` PRÉCÉDENT de
 * l'erreur ciblée) et l'enregistre comme entrée d'historique restaurable,
 * dans la même transaction que l'écriture — cf.
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

  let body: { locator?: Locator; nicad?: string; errorId?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const locator = body.locator;
  const nicad = typeof body.nicad === "string" ? body.nicad.trim() : "";
  if (!locator || (!locator.point && !locator.bbox && !locator.nicad)) {
    return NextResponse.json({ error: "Localisateur de parcelle manquant" }, { status: 400 });
  }
  if (!nicad) {
    return NextResponse.json({ error: "Nouveau NICAD requis" }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  // Même priorité de source que la correction / suppression.
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
  const idx = resolveLocator(features, locator, new Set());
  if (idx < 0) {
    return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
  }

  setFeatureNicad(features[idx], nicad);
  const correctedGeoJson = JSON.stringify(geoJson);
  const errorId = Number.isInteger(body.errorId) ? (body.errorId as number) : null;

  await prisma.$transaction(async (tx) => {
    const priorError =
      errorId !== null
        ? await tx.topologicalError.findUnique({ where: { id: errorId }, select: { id: true, corrected: true } })
        : null;

    await tx.analysis.update({
      where: { id: analysisId },
      data: { correctedData: correctedGeoJson },
    });
    if (errorId !== null) {
      await tx.topologicalError.updateMany({
        where: { analysisId, id: errorId },
        data: { corrected: true },
      });
    }

    const before: MapEditSnapshot = {
      correctedGeoJson: rawGeoJson,
      errorPatches: priorError ? [{ errorId: priorError.id, corrected: priorError.corrected }] : [],
    };
    const after: MapEditSnapshot = {
      correctedGeoJson,
      errorPatches: errorId !== null ? [{ errorId, corrected: true }] : [],
    };
    await recordHistory(tx, {
      scope: "map",
      scopeKey: String(analysisId),
      action: "map-rename",
      summary: `Réassignation du NICAD ${nicad} sur l'analyse #${analysisId}`,
      before,
      after,
      createdBy,
    });
  });

  // Persiste aussi le GeoJSON de base (clé disque) pour que les recalculs repartant
  // de la source reflètent la réassignation. Hors transaction (store non
  // transactionnel) ; `correctedData` fait foi pour l'affichage.
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  return NextResponse.json({
    success: true,
    nicad,
    correctedGeoJson,
    // Blob exact d'avant édition (utilisé par l'historique annuler/rétablir côté
    // client) : `rawGeoJson` n'a pas été muté, seule la feature parsée l'a été.
    previousCorrectedGeoJson: rawGeoJson,
  });
}
