/**
 * basculement.ts — logique partagée de basculement NICAD 2013→2026.
 *
 * Extraite de _actions/nicad.ts pour être réutilisable sans contexte Server Action.
 * Invocable à la fois depuis la page interactive (via Server Actions)
 * et depuis un job d'arrière-plan (identifierBasculementNicad + basculerNicadCore).
 */

import {
  validateNicadFormat,
  basculerNicadSimple,
  basculerNicadComplexe,
  formatNicadDisplay,
} from "@/lib/cadastre/nicad-logic";
import {
  getCommune2013BySyscol,
  getCommune2026BySyscol,
  getCorrespondanceBySyscol2013,
  findSectionSpatialMatches,
  getParcellePointByNicad2013,
  getSectionByKey,
  getLastNumParcelleGlobal,
  getNicadByCode,
  insertNicad,
  insertParcelle,
  updateNicadStatut,
  insertNicadHistorique,
  insertOperation,
} from "@/lib/cadastre/data";
import { getSectionsForPoints } from "@/lib/cadastre/sections-data";

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

export interface IdentificationResult {
  success: boolean;
  error?: string;
  dejaAJour?: boolean;
  nicad?: { syscol: string; section: string; numParcelle: string; full: string };
  commune2013?: { nomCommune: string; region: string | null; departement: string | null } | null;
  commune2026?: { nomCommune: string; region: string | null; departement: string | null } | null;
  correspondance?: {
    syscol2026: string | null;
    nomCommune2026: string | null;
    statut: string;
    typeChangement: string | null;
    departement2013: string | null;
    departement2026: string | null;
  } | null;
  sectionExisteEn2026?: boolean | null;
  flags: string[];
  clean?: boolean;
  proposition?: { syscolNouveau: string; sectionNouvelle?: string } | null;
}

export interface BasculementInput {
  nicadAncien: string;
  syscolNouveau: string;
  sectionNouvelle?: string;
  motif?: string;
  userId: string;
}

export interface BasculementResult {
  success: boolean;
  error?: string;
  cas?: "simple" | "complexe";
  nicadAncien?: string;
  nicadNouveau?: string;
  nicadNouveauFormate?: string;
  sectionAncienne?: string;
  sectionNouvelle?: string;
  communeAncienne?: string;
  communeNouvelle?: string;
  description?: string;
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
export async function identifierBasculementNicad(nicadAncien: string): Promise<IdentificationResult> {
  const formatResult = validateNicadFormat(nicadAncien);
  if (!formatResult.valid || !formatResult.parts) {
    return { success: false as const, error: `NICAD invalide : ${formatResult.errors.join(", ")}`, flags: [] };
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
      nicad: { syscol, section, numParcelle, full: nicadAncien },
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
      // Repli « Gestion des sections » : `cad_sections` (référentiel
      // statique national) n'a pas de géométrie pour cette section 2013 —
      // fréquent car ce référentiel reste à alimenter séparément. Si ce
      // NICAD correspond à une parcelle déjà connue de ce système AVEC
      // géométrie (`cad_parcelles`), on peut retrouver sa VRAIE section 2026
      // par jointure spatiale point-dans-polygone sur `limite_section`
      // (alimentée par les imports DXF/shapefile réels, via « Gestion des
      // sections ») — même mécanisme que `getSectionsForPoints`, déjà
      // utilisé par le pipeline d'import pour construire le NICAD initial.
      // Ne fonctionne que pour un NICAD déjà importé ici : un NICAD
      // totalement externe n'a pas de géométrie connue, donc pas de point
      // à projeter — la jointure spatiale reste alors impossible par
      // construction, quel que soit le référentiel interrogé.
      const point = await getParcellePointByNicad2013(nicadAncien);
      const viaLimiteSection = point ? (await getSectionsForPoints([point]))[0] : null;

      if (viaLimiteSection?.syscolCommune === syscol2026 && viaLimiteSection.numSection) {
        sectionExisteEn2026 = true;
        if (viaLimiteSection.numSection !== section) {
          sectionNouvelleProposee = viaLimiteSection.numSection;
        }
        flags.push(
          `Géométrie de la section 2013 ${section} introuvable dans le référentiel statique — section 2026 ` +
            "retrouvée par jointure spatiale sur la parcelle connue (Gestion des sections)" +
            (viaLimiteSection.approx ? ", par proximité (≤ 50 m)" : "") +
            (viaLimiteSection.numSection !== section
              ? ` : section n° ${viaLimiteSection.numSection}` +
                (viaLimiteSection.commune ? ` (${viaLimiteSection.commune})` : "") +
                " — basculement complexe requis."
              : "."),
        );
      } else {
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
    nicad: { syscol: syscol2013, section, numParcelle, full: nicadAncien },
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
export async function basculerNicadCore(input: BasculementInput): Promise<BasculementResult> {
  const formatResult = validateNicadFormat(input.nicadAncien);
  if (!formatResult.valid) {
    return { success: false, error: `NICAD invalide: ${formatResult.errors.join(", ")}` };
  }

  const syscolNouveauPadded = input.syscolNouveau.padStart(8, "0");
  const commune2026 = await getCommune2026BySyscol(syscolNouveauPadded);
  if (!commune2026) {
    return { success: false, error: `Commune 2026 introuvable pour le Syscol ${syscolNouveauPadded}` };
  }

  let basculementResult;
  let cas: "simple" | "complexe";

  if (!input.sectionNouvelle) {
    basculementResult = basculerNicadSimple(input.nicadAncien, syscolNouveauPadded);
    cas = "simple";
  } else {
    const sectionNouvellePadded = input.sectionNouvelle.padStart(3, "0");
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
      input.nicadAncien,
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
    createdBy: input.userId,
  });

  if (cas === "complexe") {
    await insertParcelle({
      syscolCommune: syscolNouveauPadded,
      numSection: sectionNouvelle,
      numParcelle: numParcelleNouveau,
      version: "2026",
      nicad: nicadNouveau,
      statut: "bascule",
      createdBy: input.userId,
    });
  }

  await updateNicadStatut(input.nicadAncien, "bascule", nicadNouveau);

  const commune2013 = await getCommune2013BySyscol(syscolAncien);
  await insertNicadHistorique({
    nicadAncien: input.nicadAncien,
    nicadNouveau,
    syscolAncien,
    syscolNouveau: syscolNouveauPadded,
    sectionAncienne,
    sectionNouvelle,
    communeAncienne: commune2013?.nomCommune,
    communeNouvelle: commune2026.nomCommune,
    motif:
      input.motif ??
      (cas === "simple"
        ? "Basculement simple : Syscol 2013 → 2026 (section et parcelle conservées)"
        : "Basculement complexe : Syscol 2013 → 2026, section changée, nouvelle numérotation séquentielle"),
    createdBy: input.userId,
  });

  await insertOperation({
    typeOperation: "basculement",
    statut: "succes",
    description: `Basculement ${cas}: ${input.nicadAncien} → ${nicadNouveau}`,
    nbTraites: 1,
    nbSucces: 1,
    createdBy: input.userId,
  }).catch(() => {});

  return {
    success: true,
    cas,
    nicadAncien: input.nicadAncien,
    nicadNouveau,
    nicadNouveauFormate: formatNicadDisplay(nicadNouveau),
    sectionAncienne,
    sectionNouvelle,
    communeAncienne: commune2013?.nomCommune,
    communeNouvelle: commune2026.nomCommune,
    description: basculementResult.description,
  };
}
