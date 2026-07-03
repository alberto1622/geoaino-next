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
import { analyzeGeoJSON, generateAIReport } from "@/lib/geo-engine";
import { saveGeoJsonLocally } from "@/lib/geo-storage";
import { filterOutOfSenegal } from "@/lib/senegal-bounds";
import type { LayerMapping } from "@/lib/cadastral-filter";
import { loadImportUpload } from "./storage";
import { toDxfBuffer } from "./source";
import { getImportJob, setJobPhase, markJobFailed, type SourceType } from "./jobs";

type ErrType =
  | "OVERLAP" | "GAP" | "SLIVER" | "DUPLICATE"
  | "INVALID_GEOM" | "BOUNDARY_CROSS" | "MISSING_NICAD" | "SHORT_NICAD" | "SELF_INTERSECT";
type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export async function runImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run] job ${jobId} introuvable`);
    return;
  }

  try {
    await setJobPhase(jobId, "read", 5, "running");
    const sourceBuf = await loadImportUpload(job.fileKey);
    const dxfBuf = await toDxfBuffer(sourceBuf, job.sourceType as SourceType);

    await setJobPhase(jobId, "build", 10);
    const layerMapping = (job.layerMapping as LayerMapping | null) ?? undefined;
    const ingestion = await ingestDxfToParcelles(dxfBuf, job.fileName, { layerMapping });

    await setJobPhase(jobId, "nicad", 60);
    const withNicad = await assignNicad2026FromCommunes(ingestion);

    // Construction de la FeatureCollection 4326 complète (aucune troncature :
    // on ne la renvoie pas au navigateur, on l'analyse et on la stocke).
    const fc = parcellesToFeatureCollection(withNicad.parcelles);
    const totalBuilt = fc.features.length;

    await setJobPhase(jobId, "analyze", 72);
    const { kept: filteredGeoJson, removedCount: outOfSenegalCount } = filterOutOfSenegal(
      fc as unknown as { type: string; features: { type: string; geometry: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }[] },
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

    await prisma.importJob.update({ where: { id: jobId }, data: { progress: 88 } });

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
      microstationReport: withNicad.report,
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

    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: "completed",
        phase: "done",
        progress: 100,
        totalBuilt,
        analysisId: analysis.id,
        report: {
          ...(withNicad.report as unknown as Record<string, unknown>),
          totalFeatures: result.totalFeatures,
          errorCount: result.errors.length,
          conformityScore: result.stats.conformityScore,
          outOfSenegalCount,
        },
      },
    });
  } catch (err) {
    console.error(`[import/run] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
}
