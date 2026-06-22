/**
 * nicad.ts
 *
 * Construction du NICAD (identifiant cadastral, 16 caractères) à partir du
 * numéro de parcelle extrait du DXF, suivant la structure DGID :
 *
 *   région (2) + département (1) + arrondissement (3) + commune (2)
 *   + section (3) + parcelle (5) = 16 caractères.
 *
 * Les 8 premiers caractères (Syscol, préfixe territorial région→commune) ne
 * figurent pas dans le dessin : pour les données DXF, ils sont résolus par
 * jointure spatiale sur la table `cad_communes_2026` (commune 2026 contenant la
 * parcelle), cf. `src/lib/cadastre/assign-nicad-2026.ts`. La section (3) et la
 * parcelle (5) sont issues du DXF (jointure spatiale + texte du calque
 * numero_parcelle).
 */

export const NICAD_PREFIX_LENGTH = 8; // région(2)+département(1)+arrondissement(3)+commune(2)
export const NICAD_SECTION_LENGTH = 3;
export const NICAD_PARCELLE_LENGTH = 5;
export const NICAD_TOTAL_LENGTH =
  NICAD_PREFIX_LENGTH + NICAD_SECTION_LENGTH + NICAD_PARCELLE_LENGTH; // 16

export type NumeroParcelleStatus = "ok" | "padded" | "truncated" | "none";

export interface NumeroParcelleResult {
  /** Numéro normalisé à 5 chiffres, ou `null` si aucun chiffre exploitable. */
  value: string | null;
  status: NumeroParcelleStatus;
}

/**
 * Extrait les chiffres d'un libellé de numéro de parcelle et le normalise à
 * exactement 5 caractères numériques (étape : "numero_parcelle en 5 caractères
 * numérique"). Padding gauche par des zéros si trop court, troncature des 5
 * derniers chiffres si trop long — chaque ajustement est signalé via `status`.
 */
export function normalizeNumeroParcelle(
  raw: string | null | undefined
): NumeroParcelleResult {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return { value: null, status: "none" };
  if (digits.length === NICAD_PARCELLE_LENGTH) return { value: digits, status: "ok" };
  if (digits.length < NICAD_PARCELLE_LENGTH) {
    return { value: digits.padStart(NICAD_PARCELLE_LENGTH, "0"), status: "padded" };
  }
  // > 5 chiffres : on conserve les 5 derniers (le numéro de parcelle est en
  // fin de chaîne lorsque le libellé contient aussi un préfixe de lot/section).
  return { value: digits.slice(-NICAD_PARCELLE_LENGTH), status: "truncated" };
}

/** Normalise une section à 3 chiffres depuis son texte (ex. "Section 42" → "042"). */
export function normalizeSection(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.slice(-NICAD_SECTION_LENGTH).padStart(NICAD_SECTION_LENGTH, "0");
}

export interface NicadPrefixResult {
  prefix: string;
  warning?: string;
}

/**
 * Normalise le préfixe territorial à 8 caractères. Doit être appelé une seule
 * fois par import (le préfixe est constant pour un même fichier).
 */
export function normalizeNicadPrefix(raw: string | null | undefined): NicadPrefixResult {
  const cleaned = String(raw ?? "").replace(/\s/g, "");
  if (cleaned.length === NICAD_PREFIX_LENGTH) return { prefix: cleaned };
  if (cleaned.length === 0) {
    return {
      prefix: "0".repeat(NICAD_PREFIX_LENGTH),
      warning:
        `Préfixe territorial NICAD absent (région+département+arrondissement+commune, ` +
        `${NICAD_PREFIX_LENGTH} caractères) : NICAD préfixé de zéros, à compléter via les métadonnées d'import.`,
    };
  }
  return {
    prefix: cleaned.slice(0, NICAD_PREFIX_LENGTH).padEnd(NICAD_PREFIX_LENGTH, "0"),
    warning:
      `Préfixe territorial NICAD "${raw}" de longueur ${cleaned.length} ≠ ${NICAD_PREFIX_LENGTH} : ajusté.`,
  };
}

/**
 * Assemble le NICAD 16 caractères à partir du préfixe territorial déjà
 * normalisé (`normalizeNicadPrefix`), de la section (3) et du numéro de
 * parcelle (5). Retourne `null` si le numéro de parcelle est absent (un NICAD
 * ne peut être construit sans parcelle).
 */
export function buildNicad(
  prefix8: string,
  section3: string | null,
  parcelle5: string | null
): string | null {
  if (!parcelle5) return null;
  return `${prefix8}${section3 ?? "0".repeat(NICAD_SECTION_LENGTH)}${parcelle5}`;
}
