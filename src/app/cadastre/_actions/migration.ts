"use server";

import { z } from "zod";
import { requireUserId, requireAdmin } from "./_auth";
import {
  previewMigrationCommune,
  previewMigrationToutes,
  executerMigrationCommune,
  executerMigrationToutes,
  insertOperation,
  updateOperation,
} from "@/lib/cadastre/data";
import { basculerNicadCore } from "@/lib/cadastre/basculement";
import { listBasculeNicadJobs, getImportJob, deleteImportJob } from "@/lib/import/jobs";
import { deleteImportUpload } from "@/lib/import/storage";
import { deleteGeoJsonByKey } from "@/lib/geo-storage";
import type { BasculeNicadReport } from "@/lib/import/run-bascule-job";

export async function previewCommune(input: { syscol2013: string }) {
  await requireUserId();
  const syscol2013 = z.string().min(7).max(8).parse(input.syscol2013);
  return previewMigrationCommune(syscol2013);
}

export async function previewToutes() {
  await requireUserId();
  return previewMigrationToutes();
}

/** Historique de "Migration en masse" — un lot = un FICHIER shapefile
 * importé (`ImportJob` de kind "bascule-nicad"), pas une opération agrégée
 * (§65 CONCEPTS-TRAITEMENT-DXF.md : aligné sur la même logique que l'import
 * "parcelles", qui suit déjà ses lots par fichier plutôt que par opération). */
export async function historiqueMigrations(input?: { limit?: number }) {
  await requireUserId();
  const limit = Math.min(Math.max(input?.limit ?? 20, 1), 100);
  return listBasculeNicadJobs(limit);
}

/** Recharge un job passé (`historique`) dans le tableau de prévisualisation
 * — même forme que le suivi d'un job en cours, pour réutiliser tel quel le
 * tableau/export déjà existants. Lecture seule, pas besoin d'ADMIN. */
export async function consulterMigrationJob(input: { jobId: number }) {
  await requireUserId();
  const job = await getImportJob(input.jobId);
  if (!job || job.kind !== "bascule-nicad") {
    throw new Error("Migration introuvable.");
  }
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    error: job.error,
    report: job.report as unknown as BasculeNicadReport | null,
  };
}

/** Supprime définitivement une migration : le job ET les fichiers qu'il
 * référence sur disque (fichier uploadé d'origine, GeoJSON sauvegardé) —
 * pas seulement l'enregistrement en base. Irréversible, réservé aux
 * administrateurs (même garde que `executerBasculementListe`). */
export async function supprimerMigrationJob(input: { jobId: number }) {
  await requireAdmin();
  const job = await getImportJob(input.jobId);
  if (!job || job.kind !== "bascule-nicad") {
    throw new Error("Migration introuvable.");
  }
  const report = job.report as unknown as BasculeNicadReport | null;
  await deleteImportUpload(job.fileKey);
  await deleteGeoJsonByKey(report?.geojsonKey);
  await deleteImportJob(job.id);
  return { success: true as const };
}

const executerCommuneSchema = z.object({
  syscol2013: z.string().min(7).max(8),
  syscol2026: z.string().min(7).max(8),
});

export async function executerCommune(input: z.infer<typeof executerCommuneSchema>) {
  const userId = await requireAdmin();
  const data = executerCommuneSchema.parse(input);

  const opId = await insertOperation({
    typeOperation: "basculement",
    statut: "en_cours",
    description: `Migration en masse Syscol ${data.syscol2013} → ${data.syscol2026}`,
    createdBy: userId,
  });

  try {
    const result = await executerMigrationCommune(data.syscol2013, data.syscol2026, opId, userId);
    await updateOperation(opId, {
      statut: result.nbEchecs === 0 ? "succes" : "echec",
      nbTraites: result.nbMigres + result.nbEchecs,
      nbSucces: result.nbMigres,
      nbEchecs: result.nbEchecs,
      details: { erreurs: result.erreurs },
    });
    return { success: true, ...result };
  } catch (err) {
    await updateOperation(opId, {
      statut: "echec",
      details: { erreur: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

export async function executerToutes() {
  const userId = await requireAdmin();

  const opId = await insertOperation({
    typeOperation: "basculement",
    statut: "en_cours",
    description: "Migration en masse globale — toutes communes Syscol 2013 → 2026",
    createdBy: userId,
  });

  try {
    const result = await executerMigrationToutes(opId, userId);
    await updateOperation(opId, {
      statut: result.nbEchecs === 0 ? "succes" : "echec",
      nbTraites: result.nbMigres + result.nbEchecs,
      nbSucces: result.nbMigres,
      nbEchecs: result.nbEchecs,
      details: { details: result.details },
    });
    return { success: true, ...result };
  } catch (err) {
    await updateOperation(opId, {
      statut: "echec",
      details: { erreur: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

const executerBasculementListeSchema = z.object({
  items: z
    .array(
      z.object({
        nicadAncien: z.string().length(16),
        syscolNouveau: z.string().min(7).max(8),
        sectionNouvelle: z.string().min(1).max(3).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export async function executerBasculementListe(input: z.infer<typeof executerBasculementListeSchema>) {
  const userId = await requireAdmin();
  const data = executerBasculementListeSchema.parse(input);

  const opId = await insertOperation({
    typeOperation: "basculement",
    statut: "en_cours",
    description: `Migration en masse par shapefile : ${data.items.length} NICAD`,
    createdBy: userId,
  });

  const resultats: Array<{ nicadAncien: string; success: boolean; nicadNouveau?: string; error?: string }> = [];
  let nbMigres = 0;
  let nbEchecs = 0;

  for (const item of data.items) {
    try {
      const res = await basculerNicadCore({
        nicadAncien: item.nicadAncien,
        syscolNouveau: item.syscolNouveau,
        sectionNouvelle: item.sectionNouvelle,
        motif: "Migration en masse par import shapefile",
        userId,
      });
      if (res.success) {
        resultats.push({ nicadAncien: item.nicadAncien, success: true, nicadNouveau: res.nicadNouveau });
        nbMigres++;
      } else {
        resultats.push({ nicadAncien: item.nicadAncien, success: false, error: res.error });
        nbEchecs++;
      }
    } catch (err) {
      resultats.push({
        nicadAncien: item.nicadAncien,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      nbEchecs++;
    }
  }

  await updateOperation(opId, {
    statut: nbEchecs === 0 ? "succes" : "echec",
    nbTraites: nbMigres + nbEchecs,
    nbSucces: nbMigres,
    nbEchecs,
  });

  return { success: true as const, nbMigres, nbEchecs, resultats };
}
