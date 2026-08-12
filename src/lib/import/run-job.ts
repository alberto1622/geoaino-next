/**
 * run-job.ts — exécution asynchrone d'un traitement Microstation (DXF/DGN).
 *
 * Rejoue, hors du cycle de la requête HTTP (déclenché via `after()`), le même
 * pipeline que `POST /api/upload-geo` + `POST /api/analyses`, mais SANS faire
 * transiter le GeoJSON par le navigateur :
 *
 *   read    : relit le fichier source persisté (+ conversion DGN→DXF si besoin)
 *   build   : ingestion DXF → parcelles (lecture native + polygonisation tuilée)
 *   nicad   : résolution Syscol 2026 + assemblage NICAD (jointure spatiale)
 *   analyze : FeatureCollection 4326 → GeoJSON sur disque + Analysis + topologie
 *   done    : Analysis « COMPLETED » ; le job porte `analysisId` (→ /map/[id])
 *
 * La totalité des parcelles est analysée et sauvegardée sur disque
 * (`geojsonKey`) ; la carte les charge ensuite à la demande. Le job ne renvoie
 * qu'un identifiant d'Analysis, jamais 100k+ entités inline.
 *
 * NB : `build` et `analyze` sont CPU-intensifs et tournent dans le process Node
 * (event-loop) — déport en worker_thread = évolution possible (Phase 2).
 */
import { prisma } from "@/lib/prisma";
import {
  ingestDxfToParcelles,
  parcellesToFeatureCollection,
} from "@/lib/parcelle-ingestion";
import { assignNicad2026FromCommunes } from "@/lib/cadastre/assign-nicad-2026";
import { buildLimiteSections } from "@/lib/cadastre/build-sections";
import { analyzeGeoJSON, generateAIReport } from "@/lib/geo-engine";
import { saveGeoJsonLocally } from "@/lib/geo-storage";
import { filterOutOfSenegal } from "@/lib/senegal-bounds";
import type { LayerMapping } from "@/lib/cadastral-filter";
import { loadImportUpload } from "./storage";
import { toDxfBuffer } from "./source";
import { getImportJob, setJobPhase, markJobFailed, assertNotCancelled, JobCancelledError, type SourceType } from "./jobs";
import { runShapefileImportJob } from "./run-shapefile-job";

type ErrType =
  | "OVERLAP" | "GAP" | "SLIVER" | "DUPLICATE"
  | "INVALID_GEOM" | "BOUNDARY_CROSS" | "MISSING_NICAD" | "SHORT_NICAD" | "SELF_INTERSECT";
type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Dispatcher : délègue au runner shapefile si `sourceType === "SHP"`, sinon exécute le pipeline DXF ci-dessous. */
export async function runImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run] job ${jobId} introuvable`);
    return;
  }
  if (job.sourceType === "SHP") {
    return runShapefileImportJob(jobId);
  }
  return runDxfImportJob(jobId);
}

async function runDxfImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) return;

  try {
    await setJobPhase(jobId, "read", 5, "running");
    const sourceBuf = await loadImportUpload(job.fileKey);
    const dxfBuf = await toDxfBuffer(sourceBuf, job.sourceType as SourceType);

    const layerMapping = (job.layerMapping as LayerMapping | null) ?? undefined;

    // ── Cible « sections » : construit la table limite_section + contrôle des
    // chevauchements, sans composer les parcelles ni produire d'Analysis. ──
    if (job.kind === "sections") {
      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "build", 20);
      const ingestion = await ingestDxfToParcelles(dxfBuf, job.fileName, {
        layerMapping,
        sectionsOnly: true,
      });

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "sections", 65);
      const built = await buildLimiteSections(ingestion, job.fileName);

      await prisma.importJob.updateMany({
        where: { id: jobId, status: { not: "cancelled" } },
        data: {
          status: "completed",
          phase: "done",
          progress: 100,
          totalBuilt: built.nbSections,
          report: {
            kind: "sections",
            sourceFichier: built.sourceFichier,
            nbSections: built.nbSections,
            nbSansCommune: built.nbSansCommune,
            nbOverlaps: built.nbOverlaps,
            nbEnveloppesEcartees: built.nbEnveloppesEcartees,
            nbResidusFusionnes: built.nbResidusFusionnes,
            nbResidusEcartes: built.nbResidusEcartes,
          },
        },
      });
      return;
    }

    await assertNotCancelled(jobId);
    await setJobPhase(jobId, "build", 10);
    const ingestion = await ingestDxfToParcelles(dxfBuf, job.fileName, { layerMapping });

    await assertNotCancelled(jobId);
    await setJobPhase(jobId, "nicad", 60);
    const withNicad = await assignNicad2026FromCommunes(ingestion);

    // Construction de la FeatureCollection 4326 complète (aucune troncature :
    // on ne la renvoie pas au navigateur, on l'analyse et on la stocke).
    const fc = parcellesToFeatureCollection(withNicad.parcelles);

    await finishParcellesJob(
      jobId,
      { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType },
      fc.features,
      { statsExtra: { microstationReport: withNicad.report }, reportExtra: withNicad.report as unknown as Record<string, unknown> },
    );
    return;
  } catch (err) {
    if (err instanceof JobCancelledError) {
      console.log(`[import/run] ${err.message}`);
      return;
    }
    console.error(`[import/run] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Queue commune « analyse → persistance → complétion » partagée par les
 * pipelines DXF et shapefile une fois les features en 4326 disponibles :
 * filtrage Sénégal → sauvegarde disque → `Analysis.create` → `analyzeGeoJSON`
 * → rapport IA → insertion batchée des erreurs topologiques → `Analysis.update`
 * → complétion de l'`ImportJob`.
 *
 * `extra.statsExtra`/`extra.reportExtra` permettent à chaque appelant
 * d'enrichir `Analysis.summaryStats`/`ImportJob.report` avec ses propres
 * champs (ex. `microstationReport` côté DXF) sans dupliquer cette queue.
 */
export async function finishParcellesJob(
  jobId: number,
  job: { fileName: string; userId: string | null; sourceType: SourceType },
  features: GeoJSON.Feature[],
  extra: { statsExtra?: Record<string, unknown>; reportExtra?: Record<string, unknown> } = {},
): Promise<void> {
  await assertNotCancelled(jobId);
  await setJobPhase(jobId, "analyze", 72);
  const { kept: filteredGeoJson, removedCount: outOfSenegalCount } = filterOutOfSenegal(
    { type: "FeatureCollection", features } as unknown as { type: string; features: { type: string; geometry: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }[] },
  );

  // Persistance du GeoJSON complet sur disque (clé référencée par l'Analysis).
  const geojsonKey = await saveGeoJsonLocally(
    job.fileName,
    JSON.stringify(filteredGeoJson),
    job.userId,
  );

  const analysis = await prisma.analysis.create({
    data: {
      userId: job.userId ?? undefined,
      fileName: job.fileName,
      fileFormat: job.sourceType,
      status: "PROCESSING",
      geoJsonData: JSON.stringify({ type: "FeatureCollection", features: [] }),
      geojsonKey,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = analyzeGeoJSON(filteredGeoJson as any);

  await prisma.importJob.updateMany({
    where: { id: jobId, status: { not: "cancelled" } },
    data: { progress: 88 },
  });

  let aiReport: string | null = null;
  try {
    aiReport = await generateAIReport(result, job.fileName);
  } catch (aiErr) {
    console.warn(`[import/run] génération du rapport IA ignorée (job ${jobId}):`, aiErr);
  }

  if (result.errors.length > 0) {
    const BATCH = 100;
    for (let i = 0; i < result.errors.length; i += BATCH) {
      const batch = result.errors.slice(i, i + BATCH).map((e) => ({
        analysisId: analysis.id,
        errorType: e.type.toUpperCase() as ErrType,
        severity: e.severity.toUpperCase() as Sev,
        nicad1: e.nicad1 ?? null,
        nicad2: e.nicad2 ?? null,
        description: e.description,
        geometry: e.geometry ?? undefined,
        area: e.area != null ? e.area.toString() : null,
        confidence: String(e.confidence),
      }));
      await prisma.topologicalError.createMany({ data: batch });
    }
  }

  const stats = {
    ...result.stats,
    outOfSenegalCount,
    ...extra.statsExtra,
  };

  await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      status: "COMPLETED",
      totalFeatures: result.totalFeatures,
      errorCount: result.errors.length,
      conformityScore: result.stats.conformityScore.toString(),
      summaryStats: stats as object,
      aiReport,
    },
  });

  await prisma.importJob.updateMany({
    where: { id: jobId, status: { not: "cancelled" } },
    data: {
      status: "completed",
      phase: "done",
      progress: 100,
      totalBuilt: features.length,
      analysisId: analysis.id,
      report: {
        ...extra.reportExtra,
        totalFeatures: result.totalFeatures,
        errorCount: result.errors.length,
        conformityScore: result.stats.conformityScore,
        outOfSenegalCount,
      },
    },
  });
}
