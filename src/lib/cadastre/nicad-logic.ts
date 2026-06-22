/**
 * Logique métier des NICAD (Numéro d'Identification Cadastral)
 * Module Cadastre — porté depuis vericad/server/nicad.ts (fonctions PURES, aucune dépendance DB).
 *
 * ─── Structure NICAD : 16 caractères ────────────────────────────────────────
 *   [Syscol × 8] + [Section × 3] + [Parcelle × 5] = 16 caractères
 *
 *   Syscol   : Système de Codification des Collectivités (8 chiffres, ≠ 00000000)
 *   Section  : Numéro de section cadastrale (3 chiffres, ≠ 000)
 *   Parcelle : Numéro de parcelle dans la section (5 chiffres)
 *
 *   Exemple : commune 01430121, section 001, parcelle 00001
 *             → NICAD = 0143012100100001
 *
 * ─── Règles de basculement 2013 → 2026 ───────────────────────────────────────
 *   CAS SIMPLE  : La section n'a pas changé de commune
 *                 → NICAD_2026 = Syscol2026 + Section2013 + NumParcelle2013
 *   CAS COMPLEXE : La section a changé de commune (redécoupage administratif)
 *                 → Nouveau NICAD attribué par numérotation séquentielle dans
 *                   la section cible de la commune 2026.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NicadParts {
  syscol: string; // 8 chiffres — code commune
  section: string; // 3 chiffres — code section
  numParcelle: string; // 5 chiffres — numéro de parcelle
  full: string; // 16 chiffres complets
}

export interface ValidationResult {
  valid: boolean;
  nicad: string;
  errors: string[];
  warnings: string[];
  parts?: NicadParts;
}

export type BasculementCas = "simple" | "complexe";

export interface BasculementResult {
  cas: BasculementCas;
  nicadAncien: string;
  nicadNouveau: string;
  nicadNouveauFormate: string;
  syscolAncien: string;
  syscolNouveau: string;
  sectionAncienne: string;
  sectionNouvelle: string;
  numParcelleAncien: string;
  numParcelleNouveau: string;
  description: string;
}

export interface CohérenceResult {
  nicad: string;
  valide: boolean;
  anomalies: string[];
  avertissements: string[];
  commune?: string;
  section?: string;
  numParcelle?: string;
}

// ─── Validation du format ─────────────────────────────────────────────────────

/**
 * Valide le format d'un NICAD (16 caractères : 8 Syscol + 3 Section + 5 Parcelle).
 * La section 000 est invalide (une section cadastrale doit avoir un numéro ≥ 001).
 */
export function validateNicadFormat(nicad: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleaned = (nicad ?? "").trim().replace(/[\s\-_·]/g, "");

  if (!cleaned) {
    return { valid: false, nicad: cleaned, errors: ["Le NICAD ne peut pas être vide"], warnings };
  }

  if (!/^\d+$/.test(cleaned)) {
    errors.push("Le NICAD ne doit contenir que des chiffres numériques");
  }

  if (cleaned.length !== 16) {
    errors.push(
      `Le NICAD doit contenir exactement 16 chiffres — reçu : ${cleaned.length}. ` +
        `Structure : [Syscol×8][Section×3][Parcelle×5]`,
    );
  }

  if (errors.length > 0) {
    return { valid: false, nicad: cleaned, errors, warnings };
  }

  const syscol = cleaned.substring(0, 8);
  const section = cleaned.substring(8, 11);
  const numParcelle = cleaned.substring(11, 16);

  if (syscol === "00000000") {
    errors.push("Le code Syscol (8 premiers chiffres) ne peut pas être 00000000");
  }
  if (section === "000") {
    errors.push(
      "Le code Section (positions 9–11) ne peut pas être 000 — une section cadastrale doit avoir un numéro valide (001 à 999)",
    );
  }
  if (numParcelle === "00000") {
    warnings.push("Le numéro de Parcelle (positions 12–16) est 00000 — valeur nulle");
  }

  return {
    valid: errors.length === 0,
    nicad: cleaned,
    errors,
    warnings,
    parts: { syscol, section, numParcelle, full: cleaned },
  };
}

// ─── Génération ───────────────────────────────────────────────────────────────

/**
 * Génère un NICAD à partir du Syscol, du numéro de Section et du numéro de Parcelle.
 * Chaque composant est padded automatiquement.
 */
export function generateNicad(
  syscol: string | number,
  section: string | number,
  numParcelle: string | number,
): string {
  const syscolStr = String(syscol).padStart(8, "0");
  const sectionStr = String(section).padStart(3, "0");
  const numStr = String(numParcelle).padStart(5, "0");

  if (syscolStr.length > 8) throw new Error(`Code Syscol trop long (max 8) : "${syscolStr}"`);
  if (sectionStr.length > 3) throw new Error(`Code Section trop long (max 3) : "${sectionStr}"`);
  if (numStr.length > 5) throw new Error(`Numéro Parcelle trop long (max 5) : "${numStr}"`);

  return syscolStr + sectionStr + numStr;
}

// ─── Numérotation séquentielle par section ────────────────────────────────────

/**
 * Calcule le prochain numéro de parcelle à partir d'une liste de numParcelle (strings).
 * Retourne 1 si la liste est vide (première parcelle de la section).
 */
export function getNextNumParcelleFromList(existingNums: string[]): number {
  if (existingNums.length === 0) return 1;
  const nums = existingNums.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n) && n > 0);
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

// ─── Basculement 2013 → 2026 ──────────────────────────────────────────────────

/**
 * CAS SIMPLE : La section n'a pas changé de commune.
 * Le Syscol change mais la section et le numéro de parcelle restent identiques.
 */
export function basculerNicadSimple(
  nicadAncien: string,
  syscolNouveau: string | number,
): BasculementResult {
  const validation = validateNicadFormat(nicadAncien);
  if (!validation.valid || !validation.parts) {
    throw new Error(`NICAD invalide : ${validation.errors.join(", ")}`);
  }

  const { syscol: syscolAncien, section, numParcelle } = validation.parts;
  const syscolNouveauPadded = String(syscolNouveau).padStart(8, "0");
  const nicadNouveau = syscolNouveauPadded + section + numParcelle;

  return {
    cas: "simple",
    nicadAncien,
    nicadNouveau,
    nicadNouveauFormate: formatNicadDisplay(nicadNouveau),
    syscolAncien,
    syscolNouveau: syscolNouveauPadded,
    sectionAncienne: section,
    sectionNouvelle: section, // Section inchangée
    numParcelleAncien: numParcelle,
    numParcelleNouveau: numParcelle, // Numéro inchangé
    description:
      `Basculement simple : Syscol ${syscolAncien} → ${syscolNouveauPadded}, ` +
      `section ${section} et parcelle ${numParcelle} conservées`,
  };
}

/**
 * CAS COMPLEXE : La section a changé de commune (redécoupage administratif).
 * Un nouveau numéro de parcelle est attribué séquentiellement dans la
 * nouvelle section de la commune 2026 cible.
 */
export function basculerNicadComplexe(
  nicadAncien: string,
  syscolNouveau: string | number,
  sectionNouvelle: string | number,
  nextNumParcelleInSection: number,
): BasculementResult {
  const validation = validateNicadFormat(nicadAncien);
  if (!validation.valid || !validation.parts) {
    throw new Error(`NICAD invalide : ${validation.errors.join(", ")}`);
  }

  const { syscol: syscolAncien, section: sectionAncienne, numParcelle: numParcelleAncien } =
    validation.parts;
  const syscolNouveauPadded = String(syscolNouveau).padStart(8, "0");
  const sectionNouvellePadded = String(sectionNouvelle).padStart(3, "0");
  const numParcelleNouveau = String(nextNumParcelleInSection).padStart(5, "0");

  const nicadNouveau = syscolNouveauPadded + sectionNouvellePadded + numParcelleNouveau;

  return {
    cas: "complexe",
    nicadAncien,
    nicadNouveau,
    nicadNouveauFormate: formatNicadDisplay(nicadNouveau),
    syscolAncien,
    syscolNouveau: syscolNouveauPadded,
    sectionAncienne,
    sectionNouvelle: sectionNouvellePadded,
    numParcelleAncien,
    numParcelleNouveau,
    description:
      `Basculement complexe : Syscol ${syscolAncien} → ${syscolNouveauPadded}, ` +
      `section ${sectionAncienne} → ${sectionNouvellePadded}, ` +
      `parcelle ${numParcelleAncien} → ${numParcelleNouveau} (nouvelle numérotation séquentielle)`,
  };
}

/**
 * Alias de compatibilité — effectue un basculement simple (section et parcelle conservées).
 */
export function basculerNicad(
  nicadAncien: string,
  syscolNouveau: string | number,
): { nicadNouveau: string; syscolAncien: string; section: string; numParcelle: string } {
  const result = basculerNicadSimple(nicadAncien, syscolNouveau);
  return {
    nicadNouveau: result.nicadNouveau,
    syscolAncien: result.syscolAncien,
    section: result.sectionNouvelle,
    numParcelle: result.numParcelleNouveau,
  };
}

// ─── Vérification de cohérence d'une couche parcelle ─────────────────────────

export interface ParcelleAuditInput {
  nicad: string;
  syscolCommune?: string;
  numSection?: string;
  numParcelle?: string;
  nomCommune?: string;
}

/**
 * Vérifie la cohérence d'un NICAD par rapport aux données attendues d'une parcelle.
 */
export function verifierCohérenceNicad(input: ParcelleAuditInput): CohérenceResult {
  const anomalies: string[] = [];
  const avertissements: string[] = [];

  const formatResult = validateNicadFormat(input.nicad);
  if (!formatResult.valid) {
    return {
      nicad: input.nicad,
      valide: false,
      anomalies: formatResult.errors,
      avertissements: formatResult.warnings,
    };
  }

  avertissements.push(...formatResult.warnings);
  const { syscol, section, numParcelle } = formatResult.parts!;

  if (input.syscolCommune) {
    const syscolAttendu = input.syscolCommune.padStart(8, "0");
    if (syscol !== syscolAttendu) {
      anomalies.push(
        `Syscol incohérent : NICAD contient ${syscol}, attendu ${syscolAttendu}` +
          (input.nomCommune ? ` (commune : ${input.nomCommune})` : ""),
      );
    }
  }

  if (input.numSection) {
    const sectionAttendue = input.numSection.padStart(3, "0");
    if (section !== sectionAttendue) {
      anomalies.push(`Section incohérente : NICAD contient ${section}, attendu ${sectionAttendue}`);
    }
  }

  if (input.numParcelle) {
    const parcelleAttendue = input.numParcelle.padStart(5, "0");
    if (numParcelle !== parcelleAttendue) {
      anomalies.push(
        `Numéro de parcelle incohérent : NICAD contient ${numParcelle}, attendu ${parcelleAttendue}`,
      );
    }
  }

  return {
    nicad: input.nicad,
    valide: anomalies.length === 0,
    anomalies,
    avertissements,
    commune: input.nomCommune,
    section,
    numParcelle,
  };
}

/**
 * Vérifie la cohérence d'un batch de parcelles avec leurs NICAD.
 */
export function auditerCoucheParcelle(parcelles: ParcelleAuditInput[]): {
  total: number;
  valides: number;
  invalides: number;
  avecAvertissements: number;
  resultats: CohérenceResult[];
  anomaliesParType: Record<string, number>;
} {
  const resultats = parcelles.map(verifierCohérenceNicad);

  const valides = resultats.filter((r) => r.valide).length;
  const invalides = resultats.filter((r) => !r.valide).length;
  const avecAvertissements = resultats.filter((r) => r.avertissements.length > 0).length;

  const anomaliesParType: Record<string, number> = {};
  for (const r of resultats) {
    for (const a of r.anomalies) {
      const type = a.startsWith("Syscol")
        ? "syscol_incohérent"
        : a.startsWith("Section")
          ? "section_incohérente"
          : a.startsWith("Numéro de parcelle")
            ? "parcelle_incohérente"
            : a.includes("16 chiffres")
              ? "format_invalide"
              : "autre";
      anomaliesParType[type] = (anomaliesParType[type] ?? 0) + 1;
    }
  }

  return { total: parcelles.length, valides, invalides, avecAvertissements, resultats, anomaliesParType };
}

// ─── Parsing et utilitaires ───────────────────────────────────────────────────

export function parseNicad(nicad: string): NicadParts | null {
  return validateNicadFormat(nicad).parts ?? null;
}

export function isSameParcelle(nicad1: string, nicad2: string): boolean {
  const p1 = parseNicad(nicad1);
  const p2 = parseNicad(nicad2);
  if (!p1 || !p2) return false;
  return p1.section === p2.section && p1.numParcelle === p2.numParcelle;
}

/**
 * Formate un NICAD pour l'affichage avec séparateurs visuels.
 * Ex: 0143012100100001 → 01430121 · 001 · 00001
 */
export function formatNicadDisplay(nicad: string): string {
  if (!nicad || nicad.length !== 16) return nicad ?? "";
  return `${nicad.substring(0, 8)} · ${nicad.substring(8, 11)} · ${nicad.substring(11, 16)}`;
}

/**
 * Formate un NICAD avec tirets.
 * Ex: 0143012100100001 → 01430121-001-00001
 */
export function formatNicadHyphen(nicad: string): string {
  if (!nicad || nicad.length !== 16) return nicad ?? "";
  return `${nicad.substring(0, 8)}-${nicad.substring(8, 11)}-${nicad.substring(11, 16)}`;
}

/**
 * Construit le préfixe de recherche pour une section donnée.
 */
export function buildSectionPrefix(syscol: string, section: string): string {
  return syscol.padStart(8, "0") + section.padStart(3, "0");
}

/**
 * Valide un batch de NICAD et retourne les résultats agrégés.
 */
export function validateNicadBatch(nicads: string[]): {
  valid: string[];
  invalid: Array<{ nicad: string; errors: string[] }>;
  results: Array<ValidationResult>;
  stats: { total: number; valid: number; invalid: number };
} {
  const valid: string[] = [];
  const invalid: Array<{ nicad: string; errors: string[] }> = [];
  const results: ValidationResult[] = [];

  for (const nicad of nicads) {
    const result = validateNicadFormat(nicad);
    results.push(result);
    if (result.valid) {
      valid.push(nicad);
    } else {
      invalid.push({ nicad, errors: result.errors });
    }
  }

  return {
    valid,
    invalid,
    results,
    stats: { total: nicads.length, valid: valid.length, invalid: invalid.length },
  };
}
