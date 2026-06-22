"use server";

import { z } from "zod";
import { requireUserId } from "./_auth";
import { insertOperation, updateOperation } from "@/lib/cadastre/data";
import {
  importCommunes2013,
  importCommunes2026,
  importSections,
  importParcelles,
  importNicads,
  exportData,
  type FichierInput,
} from "@/lib/cadastre/import-data";

const uploadSchema = z.object({
  typeImport: z.enum(["communes2013", "communes2026", "nicads", "sections", "parcelles"]),
  fichiers: z.array(z.object({ nom: z.string(), contenu: z.string() })),
});

export async function uploadShapefile(input: z.infer<typeof uploadSchema>) {
  const userId = await requireUserId();
  const data = uploadSchema.parse(input);
  const fichiers = data.fichiers as FichierInput[];

  const opId = await insertOperation({
    typeOperation: "import",
    statut: "en_cours",
    description: `Import ${data.typeImport}: ${fichiers.map((f) => f.nom).join(", ")}`,
    createdBy: userId,
  });

  try {
    let result: { nbImportes: number; nbIgnores?: number; nbErreurs?: number; warnings?: string[] };
    if (data.typeImport === "communes2013") result = await importCommunes2013(fichiers);
    else if (data.typeImport === "communes2026") result = await importCommunes2026(fichiers);
    else if (data.typeImport === "sections") result = await importSections(fichiers);
    else if (data.typeImport === "parcelles") result = await importParcelles(fichiers);
    else result = await importNicads(fichiers, userId);

    await updateOperation(opId, {
      statut: "succes",
      nbTraites: result.nbImportes,
      nbSucces: result.nbImportes,
      nbEchecs: 0,
    });
    return { success: true, ...result };
  } catch (err) {
    await updateOperation(opId, { statut: "echec", nbTraites: 0, nbSucces: 0, nbEchecs: 1 });
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erreur inconnue lors de l'import",
      nbImportes: 0,
    };
  }
}

const exportSchema = z.object({
  typeExport: z.enum(["nicads", "historique", "communes2013", "communes2026"]),
  format: z.enum(["csv", "json"]),
  filtreVersion: z.enum(["2013", "2026"]).optional(),
  filtreStatut: z.enum(["actif", "bascule", "invalide"]).optional(),
  includeGeom: z.boolean().optional(),
});

export async function exportDonnees(input: z.infer<typeof exportSchema>) {
  const userId = await requireUserId();
  const data = exportSchema.parse(input);
  try {
    const result = await exportData(data);
    await insertOperation({
      typeOperation: "export",
      statut: "succes",
      description: `Export ${data.typeExport} en ${data.format}`,
      nbTraites: result.nbEntites,
      nbSucces: result.nbEntites,
      createdBy: userId,
    }).catch(() => {});
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      nbEntites: 0,
      contenu: "",
    };
  }
}
