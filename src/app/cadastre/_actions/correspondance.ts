"use server";

import { z } from "zod";
import { requireUserId } from "./_auth";
import {
  getCorrespondances,
  getCorrespondanceBySyscol2013,
  upsertCorrespondance,
  countCorrespondances,
  initCorrespondancesFromCommunes,
  recalculerCorrespondancesSpatiales,
  confirmerToutesCorrespondances,
  getSyscol2026Confirmes,
  getChangementMaps,
} from "@/lib/cadastre/data";

export async function listCorrespondances(input?: {
  region?: string;
  departement?: string;
  statut?: "confirme" | "provisoire" | "sans_correspondance";
  typeChangement?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  await requireUserId();
  return getCorrespondances({
    region: input?.region,
    departement: input?.departement,
    statut: input?.statut,
    typeChangement: input?.typeChangement,
    search: input?.search,
    limit: input?.limit ?? 100,
    offset: input?.offset ?? 0,
  });
}

export async function getCorrespondance(input: { syscol2013: string }) {
  await requireUserId();
  return getCorrespondanceBySyscol2013(input.syscol2013);
}

const upsertSchema = z.object({
  syscol2013: z.string(),
  nomCommune2013: z.string().default(""),
  syscol2026: z.string().optional(),
  nomCommune2026: z.string().optional(),
  region: z.string().optional(),
  departement: z.string().optional(),
  statut: z.string().default("provisoire"),
  notes: z.string().optional(),
});

export async function upsertCorrespondanceAction(input: z.infer<typeof upsertSchema>) {
  await requireUserId();
  await upsertCorrespondance(upsertSchema.parse(input));
  return { success: true };
}

export async function initCorrespondances() {
  await requireUserId();
  return initCorrespondancesFromCommunes();
}

// Recalcul spatial (overlay PostGIS) : qualifie le type de changement 2013→2026
// (découpage, fusion, rattachement de département, renommage). Remplace la table.
export async function recalculerCorrespondances() {
  await requireUserId();
  return recalculerCorrespondancesSpatiales();
}

export async function confirmerToutes() {
  await requireUserId();
  const nb = await confirmerToutesCorrespondances();
  return { nb };
}

export async function countCorrespondancesAction() {
  await requireUserId();
  return countCorrespondances();
}

// Syscol 2026 ayant une correspondance confirmée avec 2013 (pour la carte).
export async function listSyscol2026Confirmes() {
  await requireUserId();
  return getSyscol2026Confirmes();
}

// Cartes type de changement (indexées par syscol 2013 et 2026) pour la carte.
export async function listChangementMaps() {
  await requireUserId();
  return getChangementMaps();
}
