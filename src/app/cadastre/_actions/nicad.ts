"use server";

import { z } from "zod";
import { requireUserId, requireAdmin } from "./_auth";
import {
  validateNicadFormat,
  validateNicadBatch,
  generateNicad,
  basculerNicadSimple,
  basculerNicadComplexe,
  basculerNicad,
  formatNicadDisplay,
} from "@/lib/cadastre/nicad-logic";
import {
  getNicadByCode,
  searchNicads,
  insertNicad,
  insertNicadHistorique,
  updateNicadStatut,
  getRecentNicads,
  getRecentHistorique,
  getHistoriqueByNicad,
  insertOperation,
  updateOperation,
  getCommune2013BySyscol,
  getCommune2026BySyscol,
  getSectionByKey,
  getParcelleByKey,
  getLastNumParcelleGlobal,
  insertParcelle,
  updateParcelleNicad,
} from "@/lib/cadastre/data";

// ─── Vérifier la validité d'un NICAD (format + existence en DB) ───────────────
export async function verifierNicad(input: { nicad: string }) {
  await requireUserId();
  const formatResult = validateNicadFormat(input.nicad);

  if (!formatResult.valid) {
    await insertOperation({
      typeOperation: "verification",
      statut: "succes",
      description: `Vérification NICAD invalide: ${input.nicad}`,
      nbTraites: 1,
      nbSucces: 0,
      nbEchecs: 1,
    }).catch(() => {});
    return {
      valid: false,
      formatValide: false,
      existeEnDB: false,
      nicad: input.nicad,
      errors: formatResult.errors,
      warnings: formatResult.warnings,
      details: null,
    };
  }

  const existingNicad = await getNicadByCode(formatResult.nicad);

  await insertOperation({
    typeOperation: "verification",
    statut: "succes",
    description: `Vérification NICAD ${existingNicad ? "trouvé" : "absent"}: ${formatResult.nicad}`,
    nbTraites: 1,
    nbSucces: 1,
    nbEchecs: 0,
  }).catch(() => {});

  return {
    valid: formatResult.valid,
    formatValide: true,
    existeEnDB: !!existingNicad,
    nicad: formatResult.nicad,
    nicadFormate: formatNicadDisplay(formatResult.nicad),
    errors: formatResult.errors,
    warnings: formatResult.warnings,
    parts: formatResult.parts,
    details: existingNicad ?? null,
  };
}

// ─── Vérifier un batch de NICAD ───────────────────────────────────────────────
export async function verifierBatch(input: { nicads: string[] }) {
  await requireUserId();
  const nicads = z.array(z.string()).max(1000).parse(input.nicads);
  const result = validateNicadBatch(nicads);
  await insertOperation({
    typeOperation: "verification",
    statut: "succes",
    description: `Vérification batch de ${nicads.length} NICAD`,
    nbTraites: result.stats.total,
    nbSucces: result.stats.valid,
    nbEchecs: result.stats.invalid,
  }).catch(() => {});
  return result;
}

// ─── Générer un NICAD (vérification hiérarchique + numérotation séquentielle) ──
const genererSchema = z.object({
  syscol: z.string().min(7).max(8),
  section: z.string().min(1).max(3),
  version: z.enum(["2013", "2026"]),
  numParcelleExistant: z.string().optional(),
  nomProprietaire: z.string().optional(),
  longitude: z.number().optional(),
  latitude: z.number().optional(),
});

export async function genererNicad(input: z.infer<typeof genererSchema>) {
  const data = genererSchema.parse(input);
  const userId = await requireUserId();

  const syscolPadded = data.syscol.padStart(8, "0");
  const sectionPadded = data.section.padStart(3, "0");

  const commune =
    data.version === "2026"
      ? await getCommune2026BySyscol(syscolPadded)
      : await getCommune2013BySyscol(syscolPadded);

  if (!commune) {
    return {
      success: false,
      error: `Commune introuvable pour le Syscol ${syscolPadded} (version ${data.version})`,
      step: "commune",
    };
  }

  const section = await getSectionByKey(syscolPadded, sectionPadded, data.version);
  if (!section) {
    return {
      success: false,
      error: `Section ${sectionPadded} introuvable dans la commune ${syscolPadded} (version ${data.version}). Importez d'abord les sections.`,
      step: "section",
      commune: { nom: commune.nomCommune, syscol: syscolPadded },
    };
  }

  let parcelleExistante: Awaited<ReturnType<typeof getParcelleByKey>> = null;
  if (data.numParcelleExistant) {
    const numParcPadded = data.numParcelleExistant.padStart(5, "0");
    parcelleExistante = await getParcelleByKey(syscolPadded, sectionPadded, numParcPadded, data.version);
    if (!parcelleExistante) {
      return {
        success: false,
        error: `Parcelle ${numParcPadded} introuvable dans la section ${sectionPadded} de la commune ${syscolPadded}`,
        step: "parcelle",
      };
    }
    if (parcelleExistante.nicad) {
      return {
        success: false,
        error: `La parcelle ${numParcPadded} possède déjà un NICAD : ${parcelleExistante.nicad}`,
        step: "parcelle",
        nicadExistant: parcelleExistante.nicad,
      };
    }
  }

  const lastNum = await getLastNumParcelleGlobal(syscolPadded, sectionPadded, data.version);
  const nextNum = lastNum + 1;
  const numPadded = String(nextNum).padStart(5, "0");

  if (nextNum > 99999) {
    return {
      success: false,
      error: `La section ${sectionPadded} a atteint le nombre maximum de parcelles (99999)`,
      step: "numerotation",
    };
  }

  const nicadCode = generateNicad(syscolPadded, sectionPadded, numPadded);

  const existing = await getNicadByCode(nicadCode);
  if (existing) {
    return {
      success: false,
      nicad: nicadCode,
      error: `NICAD ${nicadCode} déjà existant en base. Incohérence détectée.`,
      step: "unicite",
    };
  }

  const nomCommune = commune.nomCommune;
  const region = (commune as { region?: string | null }).region ?? undefined;
  const departement = (commune as { departement?: string | null }).departement ?? undefined;

  await insertNicad({
    nicad: nicadCode,
    syscol: syscolPadded,
    section: sectionPadded,
    numParcelle: numPadded,
    version: data.version,
    statut: "actif",
    nomCommune,
    region,
    departement,
    longitude: data.longitude != null ? data.longitude : undefined,
    latitude: data.latitude != null ? data.latitude : undefined,
    createdBy: userId,
  });

  if (parcelleExistante) {
    await updateParcelleNicad(parcelleExistante.id, nicadCode, "actif");
  } else {
    await insertParcelle({
      syscolCommune: syscolPadded,
      numSection: sectionPadded,
      numParcelle: numPadded,
      version: data.version,
      nicad: nicadCode,
      statut: "actif",
      nomProprietaire: data.nomProprietaire,
      longitude: data.longitude != null ? data.longitude : undefined,
      latitude: data.latitude != null ? data.latitude : undefined,
      createdBy: userId,
    });
  }

  await insertOperation({
    typeOperation: "generation",
    statut: "succes",
    description: `Génération NICAD: ${nicadCode} | Commune: ${nomCommune} | Section: ${sectionPadded} | Parcelle: ${numPadded}`,
    nbTraites: 1,
    nbSucces: 1,
    createdBy: userId,
  }).catch(() => {});

  return {
    success: true,
    nicad: nicadCode,
    nicadFormate: formatNicadDisplay(nicadCode),
    parts: { syscol: syscolPadded, section: sectionPadded, numParcelle: numPadded },
    commune: { nom: nomCommune, syscol: syscolPadded },
    section: { num: sectionPadded, nom: section.nomSection },
    numerotation: {
      dernierNum: lastNum,
      nouveauNum: nextNum,
      message:
        lastNum === 0
          ? `Première parcelle de la section ${sectionPadded}`
          : `Continuation après le numéro ${String(lastNum).padStart(5, "0")}`,
    },
  };
}

// ─── Basculement intelligent 2013 → 2026 (cas simple ou complexe) ─────────────
const basculeSchema = z.object({
  nicadAncien: z.string().length(16),
  syscolNouveau: z.string().min(7).max(8),
  sectionNouvelle: z.string().min(1).max(3).optional(),
  motif: z.string().optional(),
});

export async function basculerNicadAction(input: z.infer<typeof basculeSchema>) {
  const data = basculeSchema.parse(input);
  const userId = await requireUserId();

  const formatResult = validateNicadFormat(data.nicadAncien);
  if (!formatResult.valid) {
    return { success: false, error: `NICAD invalide: ${formatResult.errors.join(", ")}` };
  }

  const syscolNouveauPadded = data.syscolNouveau.padStart(8, "0");
  const commune2026 = await getCommune2026BySyscol(syscolNouveauPadded);
  if (!commune2026) {
    return { success: false, error: `Commune 2026 introuvable pour le Syscol ${syscolNouveauPadded}` };
  }

  let basculementResult;
  let cas: "simple" | "complexe";

  if (!data.sectionNouvelle) {
    basculementResult = basculerNicadSimple(data.nicadAncien, syscolNouveauPadded);
    cas = "simple";
  } else {
    const sectionNouvellePadded = data.sectionNouvelle.padStart(3, "0");
    const sectionCible = await getSectionByKey(syscolNouveauPadded, sectionNouvellePadded, "2026");
    if (!sectionCible) {
      return {
        success: false,
        error: `Section ${sectionNouvellePadded} introuvable dans la commune 2026 ${syscolNouveauPadded}. Créez d'abord la section.`,
      };
    }
    const lastNum = await getLastNumParcelleGlobal(syscolNouveauPadded, sectionNouvellePadded, "2026");
    const nextNum = lastNum + 1;
    basculementResult = basculerNicadComplexe(
      data.nicadAncien,
      syscolNouveauPadded,
      sectionNouvellePadded,
      nextNum,
    );
    cas = "complexe";
  }

  const { nicadNouveau, syscolAncien, sectionAncienne, sectionNouvelle, numParcelleNouveau } =
    basculementResult;

  const existingNew = await getNicadByCode(nicadNouveau);
  if (existingNew) {
    return { success: false, error: `Le NICAD cible ${nicadNouveau} existe déjà en base de données` };
  }

  await insertNicad({
    nicad: nicadNouveau,
    syscol: syscolNouveauPadded,
    section: sectionNouvelle,
    numParcelle: numParcelleNouveau,
    version: "2026",
    statut: "actif",
    nomCommune: commune2026.nomCommune,
    region: commune2026.region ?? undefined,
    departement: commune2026.departement ?? undefined,
    createdBy: userId,
  });

  if (cas === "complexe") {
    await insertParcelle({
      syscolCommune: syscolNouveauPadded,
      numSection: sectionNouvelle,
      numParcelle: numParcelleNouveau,
      version: "2026",
      nicad: nicadNouveau,
      statut: "bascule",
      createdBy: userId,
    });
  }

  await updateNicadStatut(data.nicadAncien, "bascule", nicadNouveau);

  const commune2013 = await getCommune2013BySyscol(syscolAncien);
  await insertNicadHistorique({
    nicadAncien: data.nicadAncien,
    nicadNouveau,
    syscolAncien,
    syscolNouveau: syscolNouveauPadded,
    sectionAncienne,
    sectionNouvelle,
    communeAncienne: commune2013?.nomCommune,
    communeNouvelle: commune2026.nomCommune,
    motif:
      data.motif ??
      (cas === "simple"
        ? "Basculement simple : Syscol 2013 → 2026 (section et parcelle conservées)"
        : "Basculement complexe : Syscol 2013 → 2026, section changée, nouvelle numérotation séquentielle"),
    createdBy: userId,
  });

  await insertOperation({
    typeOperation: "basculement",
    statut: "succes",
    description: `Basculement ${cas}: ${data.nicadAncien} → ${nicadNouveau}`,
    nbTraites: 1,
    nbSucces: 1,
    createdBy: userId,
  }).catch(() => {});

  return {
    success: true,
    cas,
    nicadAncien: data.nicadAncien,
    nicadNouveau,
    nicadNouveauFormate: formatNicadDisplay(nicadNouveau),
    sectionAncienne,
    sectionNouvelle,
    communeAncienne: commune2013?.nomCommune,
    communeNouvelle: commune2026.nomCommune,
    description: basculementResult.description,
  };
}

// ─── Basculement en lot ───────────────────────────────────────────────────────
const basculeBatchSchema = z.object({
  nicads: z
    .array(z.object({ nicadAncien: z.string().length(16), syscolNouveau: z.string().min(7).max(8) }))
    .max(500),
  motif: z.string().optional(),
});

export async function basculerBatch(input: z.infer<typeof basculeBatchSchema>) {
  const data = basculeBatchSchema.parse(input);
  const userId = await requireAdmin();

  const results: Array<{ nicadAncien: string; nicadNouveau?: string; success: boolean; error?: string }> = [];

  const opId = await insertOperation({
    typeOperation: "basculement",
    statut: "en_cours",
    description: `Basculement batch de ${data.nicads.length} NICAD`,
    nbTraites: data.nicads.length,
    createdBy: userId,
  });

  let nbSucces = 0;
  let nbEchecs = 0;

  for (const item of data.nicads) {
    try {
      const formatResult = validateNicadFormat(item.nicadAncien);
      if (!formatResult.valid) {
        results.push({ nicadAncien: item.nicadAncien, success: false, error: formatResult.errors.join(", ") });
        nbEchecs++;
        continue;
      }

      const { nicadNouveau, syscolAncien, numParcelle } = basculerNicad(item.nicadAncien, item.syscolNouveau);
      const existingNew = await getNicadByCode(nicadNouveau);
      if (existingNew) {
        results.push({ nicadAncien: item.nicadAncien, success: false, error: `NICAD cible ${nicadNouveau} existe déjà` });
        nbEchecs++;
        continue;
      }

      const commune2026 = await getCommune2026BySyscol(item.syscolNouveau);
      const commune2013 = await getCommune2013BySyscol(syscolAncien);

      await insertNicad({
        nicad: nicadNouveau,
        syscol: item.syscolNouveau.padStart(8, "0"),
        numParcelle,
        version: "2026",
        statut: "actif",
        nomCommune: commune2026?.nomCommune,
        region: commune2026?.region ?? undefined,
        departement: commune2026?.departement ?? undefined,
        createdBy: userId,
      });

      await updateNicadStatut(item.nicadAncien, "bascule", nicadNouveau);

      await insertNicadHistorique({
        nicadAncien: item.nicadAncien,
        nicadNouveau,
        syscolAncien,
        syscolNouveau: item.syscolNouveau.padStart(8, "0"),
        communeAncienne: commune2013?.nomCommune,
        communeNouvelle: commune2026?.nomCommune,
        motif: data.motif ?? "Basculement Syscol 2013 → 2026",
        createdBy: userId,
      });

      results.push({ nicadAncien: item.nicadAncien, nicadNouveau, success: true });
      nbSucces++;
    } catch (err) {
      results.push({ nicadAncien: item.nicadAncien, success: false, error: String(err) });
      nbEchecs++;
    }
  }

  await updateOperation(opId, { statut: "succes", nbSucces, nbEchecs }).catch(() => {});

  return { results, stats: { total: data.nicads.length, succes: nbSucces, echecs: nbEchecs } };
}

// ─── Lectures ─────────────────────────────────────────────────────────────────
export async function getNicad(input: { nicad: string }) {
  await requireUserId();
  return (await getNicadByCode(input.nicad)) ?? null;
}

export async function rechercherNicad(input: { query: string; limit?: number }) {
  await requireUserId();
  return searchNicads(input.query, input.limit ?? 20);
}

export async function historiqueNicad(input: { nicad: string }) {
  await requireUserId();
  return getHistoriqueByNicad(input.nicad);
}

export async function historiqueRecent(input?: { limit?: number }) {
  await requireUserId();
  return getRecentHistorique(input?.limit ?? 20);
}

export async function nicadsRecents(input?: { limit?: number }) {
  await requireUserId();
  return getRecentNicads(input?.limit ?? 10);
}
