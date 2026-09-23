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
import { listBasculeNicadJobs } from "@/lib/import/jobs";

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
