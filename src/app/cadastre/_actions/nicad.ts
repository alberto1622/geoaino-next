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
  getCorrespondanceBySyscol2013,
  findSectionSpatialMatches,
} from "@/lib/cadastre/data";

// Recouvrement mini (part de la section 2013) pour considérer une section
// 2026 comme correspondance fiable — même seuil que `SEUIL_SECTION_PROVISOIRE`
// (data.ts) : un candidat déjà filtré à ce seuil peut donc être "confirmé" ou
// "provisoire" selon qu'il dépasse ou non ce second palier, sur le même
// principe que `recalculerCorrespondancesSpatiales` au niveau commune.
const SEUIL_SECTION_CONFIRME = 0.5;
// Un deuxième candidat au-delà de ce seuil signale un découpage de la section
// 2013 entre plusieurs sections 2026 (pas juste du bruit de bord).
const SEUIL_SECTION_DECOUPE = 0.15;

// Libellé lisible du type de changement de correspondance (cf.
// `recalculerCorrespondancesSpatiales` — data.ts) pour affichage utilisateur.
const TYPE_CHANGEMENT_LABELS: Record<string, string> = {
  inchange: "Commune inchangée",
  renomme: "Commune renommée",
  rattachement_departement: "Commune rattachée à un autre département",
  decoupe: "Commune découpée en plusieurs communes 2026",
  fusion: "Commune fusionnée avec d'autres communes 2013",
  disparue: "Aucune correspondance 2026 fiable trouvée",
};

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
//    puis la section 2026 correspondante par JOINTURE SPATIALE
//    (`findSectionSpatialMatches` — recouvrement géométrique section 2013 ↔
//    sections 2026, PAS une simple égalité de numéro : un même numéro peut ne
//    plus recouvrir la même zone après redécoupage, une zone inchangée peut
//    avoir été renumérotée). Toute différence (correspondance provisoire/
//    absente, découpage/fusion/renommage de commune, section renumérotée/
//    découpée/introuvable) est remontée dans `flags` plutôt que masquée ; le
//    basculement n'est PROPOSÉ proprement (`clean`) que si tout correspond
//    sans aucun flag.
//  - Trouvé dans AUCUN des deux référentiels → NICAD invalide/saisie erronée.
const identifierSchema = z.object({ nicadAncien: z.string().length(16) });

export async function identifierBasculement(input: z.infer<typeof identifierSchema>) {
  const data = identifierSchema.parse(input);
  await requireUserId();

  const formatResult = validateNicadFormat(data.nicadAncien);
  if (!formatResult.valid || !formatResult.parts) {
    return { success: false as const, error: `NICAD invalide : ${formatResult.errors.join(", ")}` };
  }
  const { syscol, section, numParcelle } = formatResult.parts;

  const [commune2026Direct, commune2013] = await Promise.all([
    getCommune2026BySyscol(syscol),
    getCommune2013BySyscol(syscol),
  ]);

  if (commune2026Direct) {
    // Le Syscol saisi est DÉJÀ un code 2026 : rien à basculer. Un
    // chevauchement avec 2013 (le même code à 8 chiffres existerait aussi
    // dans l'autre référentiel indépendant) reste possible mais improbable —
    // signalé, jamais traité comme une raison de proposer un basculement :
    // 2026 fait autorité dès qu'il matche.
    return {
      success: true as const,
      dejaAJour: true as const,
      nicad: { syscol, section, numParcelle, full: data.nicadAncien },
      commune2013: null,
      correspondance: null,
      commune2026: {
        nomCommune: commune2026Direct.nomCommune,
        region: commune2026Direct.region,
        departement: commune2026Direct.departement,
      },
      sectionExisteEn2026: null,
      flags: commune2013
        ? [
            `Ce Syscol existe aussi dans le référentiel 2013 (commune « ${commune2013.nomCommune} ») — ` +
              "coïncidence de code entre les deux référentiels indépendants, sans effet : ce NICAD est déjà 2026.",
          ]
        : [],
      clean: false,
      proposition: null,
    };
  }

  const syscol2013 = syscol;
  const correspondance = await getCorrespondanceBySyscol2013(syscol2013);

  const flags: string[] = [];
  if (!commune2013) {
    flags.push(
      `Syscol ${syscol2013} introuvable dans les référentiels 2013 ET 2026 — vérifiez le NICAD saisi.`,
    );
  }

  const syscol2026 = correspondance?.syscol2026 ?? null;
  let commune2026: Awaited<ReturnType<typeof getCommune2026BySyscol>> = null;
  let sectionExisteEn2026: boolean | null = null;
  // Numéro de section 2026 identifié par recouvrement géométrique quand il
  // diffère du numéro 2013 (section renumérotée) — proposé pour un
  // basculement complexe, jamais deviné sans vérification spatiale.
  let sectionNouvelleProposee: string | null = null;

  if (!correspondance || !syscol2026) {
    flags.push(
      "Aucune correspondance 2026 enregistrée pour cette commune — sélectionnez la commune cible manuellement.",
    );
  } else {
    commune2026 = await getCommune2026BySyscol(syscol2026);

    if (correspondance.statut === "provisoire") {
      flags.push("Correspondance 2013 → 2026 provisoire (non confirmée) — à vérifier avant basculement.");
    } else if (correspondance.statut === "sans_correspondance") {
      flags.push("Correspondance 2013 → 2026 non fiable (recouvrement insuffisant) — à vérifier manuellement.");
    }

    if (correspondance.typeChangement && correspondance.typeChangement !== "inchange") {
      const label = TYPE_CHANGEMENT_LABELS[correspondance.typeChangement] ?? correspondance.typeChangement;
      flags.push(
        correspondance.typeChangement === "decoupe" && correspondance.cibles2026
          ? `${label} : ${correspondance.cibles2026}`
          : label,
      );
    }

    // Correspondance de section par jointure SPATIALE (pas par égalité de
    // numéro) : un même numéro peut ne plus recouvrir la même zone après
    // redécoupage, et une zone inchangée peut avoir été renumérotée.
    const spatial = await findSectionSpatialMatches(syscol2013, section, syscol2026);
    if (!spatial.source2013GeomFound) {
      flags.push(
        `Géométrie de la section 2013 ${section} introuvable — vérification spatiale impossible, ` +
          "contrôle limité au numéro de section.",
      );
      const sectionCible = await getSectionByKey(syscol2026, section, "2026");
      sectionExisteEn2026 = !!sectionCible;
      if (!sectionCible) {
        flags.push(
          `Aucune section ${section} trouvée dans la commune 2026 identifiée (${commune2026?.nomCommune ?? syscol2026}) ` +
            "— un nouveau numéro de section devra être choisi (cas complexe).",
        );
      }
    } else {
      const best = spatial.matches[0] ?? null;
      if (!best) {
        sectionExisteEn2026 = false;
        flags.push(
          `Aucune section 2026 ne recouvre significativement la section 2013 ${section} ` +
            `dans la commune identifiée (${commune2026?.nomCommune ?? syscol2026}) — nouvelle section à choisir (cas complexe).`,
        );
      } else if (best.numSection === section) {
        sectionExisteEn2026 = true;
        if (best.recouvr < SEUIL_SECTION_CONFIRME) {
          flags.push(
            `Recouvrement partiel (${Math.round(best.recouvr * 100)}%) entre la section 2013 ${section} et la ` +
              "section 2026 de même numéro — à vérifier avant basculement.",
          );
        }
      } else {
        // Zone géométriquement la même section, mais RENUMÉROTÉE en 2026.
        sectionExisteEn2026 = true;
        sectionNouvelleProposee = best.numSection;
        flags.push(
          `La section 2013 ${section} correspond spatialement à la section 2026 n° ${best.numSection}` +
            (best.nomSection ? ` (${best.nomSection})` : "") +
            ` (recouvrement ${Math.round(best.recouvr * 100)}%), PAS au numéro ${section} — ` +
            `basculement complexe requis avec ce nouveau numéro de section.`,
        );
      }
      if (spatial.matches.length > 1 && spatial.matches[1].recouvr >= SEUIL_SECTION_DECOUPE) {
        flags.push(
          `La section 2013 ${section} semble découpée entre plusieurs sections 2026 (` +
            spatial.matches.map((m) => `${m.numSection} : ${Math.round(m.recouvr * 100)}%`).join(", ") +
            ").",
        );
      }
    }
  }

  const clean = flags.length === 0 && !!correspondance && sectionExisteEn2026 === true;

  return {
    success: true as const,
    dejaAJour: false as const,
    nicad: { syscol: syscol2013, section, numParcelle, full: data.nicadAncien },
    commune2013: commune2013
      ? { nomCommune: commune2013.nomCommune, region: commune2013.region, departement: commune2013.departement }
      : null,
    commune2026: commune2026
      ? { nomCommune: commune2026.nomCommune, region: commune2026.region, departement: commune2026.departement }
      : null,
    correspondance: correspondance
      ? {
          syscol2026,
          nomCommune2026: correspondance.nomCommune2026,
          statut: correspondance.statut,
          typeChangement: correspondance.typeChangement,
          departement2013: correspondance.departement,
          departement2026: correspondance.departement2026,
        }
      : null,
    sectionExisteEn2026,
    flags,
    clean,
    // Pré-remplissage proposé du formulaire : syscol cible identifié, et
    // numéro de section UNIQUEMENT quand la jointure spatiale a confirmé une
    // renumérotation (jamais deviné sans cette vérification géométrique — si
    // aucune section 2026 ne recouvre significativement l'ancienne, c'est à
    // l'utilisateur de choisir, cf. flag ci-dessus). L'utilisateur reste libre
    // de tout corriger avant de confirmer le basculement (bouton "Basculer" séparé).
    proposition: syscol2026
      ? { syscolNouveau: syscol2026, sectionNouvelle: sectionNouvelleProposee ?? undefined }
      : null,
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
