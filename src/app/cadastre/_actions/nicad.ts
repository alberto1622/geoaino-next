"use server";

import { z } from "zod";
import { requireUserId, requireAdmin } from "./_auth";
import {
  validateNicadFormat,
  validateNicadBatch,
  generateNicad,
  basculerNicad,
  formatNicadDisplay,
} from "@/lib/cadastre/nicad-logic";
import { identifierBasculementNicad, basculerNicadCore } from "@/lib/cadastre/basculement";
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

  const [existingNicad, commune2026] = await Promise.all([
    getNicadByCode(formatResult.nicad),
    getCommune2026BySyscol(formatResult.parts!.syscol),
  ]);

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
    commune2026: commune2026
      ? { nomCommune: commune2026.nomCommune, region: commune2026.region, departement: commune2026.departement }
      : null,
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

// ─── Identification automatique de la cible 2026 avant basculement ───────────
// Principe (dans cet ordre) : à partir du seul NICAD saisi, identifier
// D'ABORD à quel référentiel appartient son Syscol.
//  - Trouvé dans `cad_communes_2026` → le NICAD est DÉJÀ 2026, à jour, rien à
//    basculer (`dejaAJour: true`) — vérifié en PREMIER, avant même de tenter
//    2013, cf. demande explicite : « si c'est de 2026 alors c'est à jour ».
//  - Sinon, trouvé dans `cad_communes_2013` → c'est un NICAD 2013 : on
//    retrouve sa correspondance 2026 (table `cad_correspondance_2013_2026`,
//    calculée par recouvrement spatial — cf. `recalculerCorrespondancesSpatiales`),
//    puis la section 2026 correspondante en interrogeant EXCLUSIVEMENT
//    `limite_section` (« Gestion des sections », réellement alimentée) —
//    cf. `identifierBasculementNicad` (basculement.ts) pour le détail.
//    Toute différence (correspondance provisoire/absente, découpage/fusion/
//    renommage de commune, section renumérotée/introuvable) est remontée
//    dans `flags` plutôt que masquée ; le basculement n'est PROPOSÉ
//    proprement (`clean`) que si tout correspond sans aucun flag.
//  - Trouvé dans AUCUN des deux référentiels → NICAD invalide/saisie erronée.
const identifierSchema = z.object({ nicadAncien: z.string().length(16) });

export async function identifierBasculement(input: z.infer<typeof identifierSchema>) {
  const data = identifierSchema.parse(input);
  await requireUserId();
  return identifierBasculementNicad(data.nicadAncien);
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
  return basculerNicadCore({
    nicadAncien: data.nicadAncien,
    syscolNouveau: data.syscolNouveau,
    sectionNouvelle: data.sectionNouvelle,
    motif: data.motif,
    userId,
  });
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
  const { query, limit } = z
    .object({ query: z.string().max(100), limit: z.number().int().min(1).max(200).optional() })
    .parse(input);
  return searchNicads(query, limit ?? 20);
}

export async function historiqueNicad(input: { nicad: string }) {
  await requireUserId();
  return getHistoriqueByNicad(input.nicad);
}

export async function historiqueRecent(input?: { limit?: number }) {
  await requireUserId();
  const limit = z.number().int().min(1).max(200).optional().parse(input?.limit);
  return getRecentHistorique(limit ?? 20);
}

export async function nicadsRecents(input?: { limit?: number }) {
  await requireUserId();
  return getRecentNicads(input?.limit ?? 10);
}
