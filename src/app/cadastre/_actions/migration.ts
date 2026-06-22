"use server";

import { z } from "zod";
import { requireUserId } from "./_auth";
import {
  previewMigrationCommune,
  previewMigrationToutes,
  executerMigrationCommune,
  executerMigrationToutes,
  insertOperation,
  updateOperation,
} from "@/lib/cadastre/data";

export async function previewCommune(input: { syscol2013: string }) {
  await requireUserId();
  const syscol2013 = z.string().min(7).max(8).parse(input.syscol2013);
  return previewMigrationCommune(syscol2013);
}

export async function previewToutes() {
  await requireUserId();
  return previewMigrationToutes();
}

const executerCommuneSchema = z.object({
  syscol2013: z.string().min(7).max(8),
  syscol2026: z.string().min(7).max(8),
});

export async function executerCommune(input: z.infer<typeof executerCommuneSchema>) {
  const userId = await requireUserId();
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
  const userId = await requireUserId();

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
