"use server";

import { z } from "zod";
import { requireUserId } from "./_auth";
import {
  getSectionsByCommune,
  getSectionByKey,
  insertSection,
  getCommune2013BySyscol,
  getCommune2026BySyscol,
} from "@/lib/cadastre/data";

export async function listSectionsByCommune(input: { syscol: string; version?: "2013" | "2026" }) {
  return getSectionsByCommune(input.syscol, input.version);
}

export async function verifierSection(input: {
  syscol: string;
  numSection: string;
  version: "2013" | "2026";
}) {
  const section = await getSectionByKey(input.syscol, input.numSection, input.version);
  return { existe: !!section, section: section ?? null };
}

const creerSchema = z.object({
  syscolCommune: z.string().min(7).max(8),
  numSection: z.string().min(1).max(3),
  nomSection: z.string().optional(),
  version: z.enum(["2013", "2026"]),
});

export async function creerSection(input: z.infer<typeof creerSchema>) {
  const data = creerSchema.parse(input);
  const userId = await requireUserId();

  const syscolPadded = data.syscolCommune.padStart(8, "0");
  const sectionPadded = data.numSection.padStart(3, "0");

  const commune =
    data.version === "2026"
      ? await getCommune2026BySyscol(syscolPadded)
      : await getCommune2013BySyscol(syscolPadded);

  if (!commune) {
    return { success: false, error: `Commune ${syscolPadded} introuvable (version ${data.version})` };
  }

  const existing = await getSectionByKey(syscolPadded, sectionPadded, data.version);
  if (existing) {
    return { success: false, error: `Section ${sectionPadded} existe déjà dans la commune ${syscolPadded}` };
  }

  await insertSection({
    syscolCommune: syscolPadded,
    numSection: sectionPadded,
    nomSection: data.nomSection,
    version: data.version,
    nomCommune: commune.nomCommune,
    region: (commune as { region?: string | null }).region ?? undefined,
    departement: (commune as { departement?: string | null }).departement ?? undefined,
    createdBy: userId,
  });

  return { success: true, syscolCommune: syscolPadded, numSection: sectionPadded };
}
