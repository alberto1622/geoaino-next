/**
 * jobs.ts — accès DB au registre des jobs de traitement Microstation
 * (`import_jobs`). Domaine cœur geoaino (pas verifcad).
 */
import { prisma } from "@/lib/prisma";

export type SourceType = "DXF" | "DGN" | "SHP";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type JobPhase = "read" | "build" | "nicad" | "analyze" | "sections" | "import" | "done";
/**
 * Cible du job :
 *  - "parcelles"/"sections" : pipeline DXF existant (Analysis / limite_section),
 *    aussi réutilisé pour le job shapefile de `SectionsClient` (kind "sections",
 *    sourceType "SHP" → même table limite_section, même report shape).
 *  - "cad-parcelles"/"cad-sections" : import shapefile en masse de
 *    `/cadastre/import` (écrit dans CadParcelle / CadSection).
 */
export type JobKind = "parcelles" | "sections" | "cad-parcelles" | "cad-sections";

export async function createImportJob(input: {
  fileName: string;
  fileKey: string;
  sourceType: SourceType;
  userId?: string | null;
  /**
   * Mappage validé par l'utilisateur avant traitement : calque → classe DGID
   * pour un job DXF (`LayerMapping`), ou champ cible → colonne .dbf pour un
   * job shapefile (`FieldMapping`, `src/lib/import/field-mapping.ts`) — les
   * deux sont des `Record<string, string>`, stockés tels quels en JSON.
   */
  layerMapping?: Record<string, string> | null;
  /** Cible du traitement (défaut "parcelles"). */
  kind?: JobKind;
}) {
  return prisma.importJob.create({
    data: {
      fileName: input.fileName,
      fileKey: input.fileKey,
      sourceType: input.sourceType,
      status: "pending",
      progress: 0,
      userId: input.userId ?? null,
      layerMapping: input.layerMapping ?? undefined,
      kind: input.kind ?? "parcelles",
    },
  });
}

export async function getImportJob(id: number) {
  return prisma.importJob.findUnique({ where: { id } });
}

export async function listImportJobs(limit = 20) {
  return prisma.importJob.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

/** Met à jour la phase + l'avancement (et éventuellement le statut). */
export async function setJobPhase(
  id: number,
  phase: JobPhase,
  progress: number,
  status?: JobStatus,
) {
  await prisma.importJob.update({
    where: { id },
    data: { phase, progress, ...(status ? { status } : {}) },
  });
}

export async function setJobProgress(id: number, progress: number) {
  await prisma.importJob.update({ where: { id }, data: { progress } });
}

export async function markJobFailed(id: number, error: string) {
  await prisma.importJob.update({
    where: { id },
    data: { status: "failed", error },
  });
}

export class JobCancelledError extends Error {
  constructor(jobId: number) {
    super(`Job ${jobId} annulé par l'utilisateur.`);
    this.name = "JobCancelledError";
  }
}

/** Point de contrôle appelé aux transitions de phase : stoppe le runner si le job a été annulé entre-temps. */
export async function assertNotCancelled(id: number): Promise<void> {
  const job = await prisma.importJob.findUnique({ where: { id }, select: { status: true } });
  if (job?.status === "cancelled") throw new JobCancelledError(id);
}

/** Marque un job `pending`/`running` comme annulé ; no-op s'il est déjà terminal. */
export async function cancelImportJob(id: number): Promise<{ cancelled: boolean }> {
  const job = await prisma.importJob.findUnique({ where: { id }, select: { status: true } });
  if (!job || (job.status !== "pending" && job.status !== "running")) {
    return { cancelled: false };
  }
  await prisma.importJob.update({ where: { id }, data: { status: "cancelled" } });
  return { cancelled: true };
}
