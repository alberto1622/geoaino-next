/**
 * jobs.ts — accès DB au registre des jobs de traitement Microstation
 * (`import_jobs`). Domaine cœur geoaino (pas verifcad).
 */
import { prisma } from "@/lib/prisma";
import type { LayerMapping } from "@/lib/cadastral-filter";

export type SourceType = "DXF" | "DGN";
export type JobStatus = "pending" | "running" | "completed" | "failed";
export type JobPhase = "read" | "build" | "nicad" | "analyze" | "sections" | "done";
/** Cible du job : parcelles (Analysis) ou limite_section (contrôle chevauchements). */
export type JobKind = "parcelles" | "sections";

export async function createImportJob(input: {
  fileName: string;
  fileKey: string;
  sourceType: SourceType;
  userId?: string | null;
  /** Mappage calque → classe DGID validé par l'utilisateur (variante « simple »). */
  layerMapping?: LayerMapping | null;
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
