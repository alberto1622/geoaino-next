/**
 * run-shapefile-job.ts — exécution asynchrone d'un job d'import shapefile
 * (`.shp`+`.dbf`, persistés ensemble sous forme de ZIP par
 * `POST /api/cadastre/import/inventory`). Symétrique de `run-job.ts` (DXF),
 * dispatché depuis `runImportJob()` quand `sourceType === "SHP"`.
 *
 *   kind "cad-parcelles" / "cad-sections" : import en masse vers CadParcelle /
 *     CadSection (mapping de champs appliqué via `importXFromFeatures`).
 *   kind "sections" : même cible que le job DXF `sections` (table
 *     limite_section) — `sectionCandidatesFromShapefile` + `buildLimiteSections`.
 */
import * as shapefile from "shapefile";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { importParcellesFromFeatures, importSectionsFromFeatures } from "@/lib/cadastre/import-data";
import { sectionCandidatesFromShapefile } from "@/lib/cadastre/sections-from-shapefile";
import { buildLimiteSections } from "@/lib/cadastre/build-sections";
import { insertOperation, updateOperation } from "@/lib/cadastre/data";
import type { FieldMapping } from "./field-mapping";
import { loadImportUpload } from "./storage";
import { getImportJob, setJobPhase, setJobProgress, markJobFailed, assertNotCancelled, JobCancelledError, type SourceType } from "./jobs";
import { reprojectFeaturesToWgs84 } from "@/lib/import/geo-parse";
import { finishParcellesJob } from "./run-job";

async function loadShapefilePair(fileKey: string): Promise<{ shpBuf: Buffer; dbfBuf: Buffer; prjBuf?: Buffer }> {
  const zipBuf = await loadImportUpload(fileKey);
  const zip = await JSZip.loadAsync(zipBuf);
  const shpEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".shp"));
  const dbfEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".dbf"));
  if (!shpEntry || !dbfEntry) throw new Error("Archive shapefile incomplète (.shp/.dbf manquant).");
  const prjEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".prj"));
  return {
    shpBuf: Buffer.from(await shpEntry.async("arraybuffer")),
    dbfBuf: Buffer.from(await dbfEntry.async("arraybuffer")),
    prjBuf: prjEntry ? Buffer.from(await prjEntry.async("arraybuffer")) : undefined,
  };
}

export async function runShapefileImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run-shapefile] job ${jobId} introuvable`);
    return;
  }

  let opId: number | null = null;

  try {
    await setJobPhase(jobId, "read", 5, "running");
    const { shpBuf, dbfBuf, prjBuf } = await loadShapefilePair(job.fileKey);
    const fieldMapping = (job.layerMapping as FieldMapping | null) ?? undefined;

    if (job.kind === "sections") {
      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "build", 25);
      const candidates = await sectionCandidatesFromShapefile(
        [
          { name: "upload.shp", buffer: shpBuf },
          { name: "upload.dbf", buffer: dbfBuf },
        ],
        { numSection: fieldMapping?.numSection },
      );
      if (candidates.length === 0) {
        throw new Error("Aucun polygone de section exploitable dans le shapefile.");
      }

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "sections", 65);
      const built = await buildLimiteSections({ sections: candidates }, job.fileName);

      await prisma.importJob.updateMany({
        where: { id: jobId, status: { not: "cancelled" } },
        data: {
          status: "completed",
          phase: "done",
          progress: 100,
          totalBuilt: built.nbSections,
          report: { kind: "sections", ...built },
        },
      });
      return;
    }

    if (job.kind === "parcelles") {
      const source = await shapefile.read(shpBuf, dbfBuf);
      let features = (source.features ?? []) as GeoJSON.Feature[];

      if (prjBuf) {
        const prjText = prjBuf.toString("utf8");
        if (prjText.includes("UTM") && prjText.includes("28")) {
          features = reprojectFeaturesToWgs84(features) as GeoJSON.Feature[];
        }
      }

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "read", 20);
      await finishParcellesJob(jobId, { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType }, features);
      return;
    }

    if (job.kind === "cad-parcelles" || job.kind === "cad-sections") {
      const source = await shapefile.read(shpBuf, dbfBuf);
      const features = (source.features ?? []) as GeoJSON.Feature[];

      opId = job.userId
        ? await insertOperation({
            typeOperation: "import",
            statut: "en_cours",
            description: `Import ${job.kind === "cad-parcelles" ? "parcelles" : "sections"} (shapefile) : ${job.fileName}`,
            createdBy: job.userId,
          })
        : null;

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "import", 10);
      const onProgress = async (done: number, total: number) => {
        await assertNotCancelled(jobId);
        const pct = 10 + Math.round((done / Math.max(total, 1)) * 85);
        await setJobProgress(jobId, Math.min(pct, 95));
      };

      const result =
        job.kind === "cad-parcelles"
          ? await importParcellesFromFeatures(features, fieldMapping, onProgress)
          : await importSectionsFromFeatures(features, fieldMapping, onProgress);

      if (opId) {
        await updateOperation(opId, {
          statut: "succes",
          nbTraites: result.nbImportes,
          nbSucces: result.nbImportes,
          nbEchecs: result.nbErreurs ?? 0,
        });
      }

      await prisma.importJob.updateMany({
        where: { id: jobId, status: { not: "cancelled" } },
        data: {
          status: "completed",
          phase: "done",
          progress: 100,
          totalBuilt: result.nbImportes,
          report: { kind: job.kind, ...result },
        },
      });
      return;
    }

    throw new Error(`kind de job shapefile non pris en charge: ${job.kind}`);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      console.log(`[import/run-shapefile] ${err.message}`);
      if (opId) await updateOperation(opId, { statut: "echec" });
      return;
    }
    console.error(`[import/run-shapefile] job ${jobId} échoué:`, err);
    if (opId) await updateOperation(opId, { statut: "echec" });
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
}
