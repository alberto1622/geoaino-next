/**
 * assign-section-nicad.ts — enrichissement + construction du NICAD des
 * parcelles shapefile (chemin page d'accueil → `Analysis`,
 * `job.kind === "parcelles"`) par jointure spatiale sur `limite_section`.
 *
 * Deux responsabilités, appliquées en une seule passe de résolution
 * spatiale :
 *
 *   1. Enrichissement : copie, pour CHAQUE feature (indépendamment de son
 *      statut NICAD), les champs mappés par l'utilisateur
 *      (FieldMappingModal, `PARCELLES_HOME_TARGET_FIELDS`) sous leurs clés
 *      canoniques dans les propriétés — region, departement, commune,
 *      quartier, numLot, superficie, codeSection — plus `sectionGeolocalisee`
 *      (codeSection à 11 chiffres syscol+section trouvé par jointure
 *      spatiale, quel que soit le statut NICAD de la feature). Ces clés
 *      canoniques sont lues telles quelles par `analyzeGeoJSON`
 *      (`geo-engine.ts`) pour détecter les incohérences de section
 *      (`section_mismatch`), sans dépendre du mappage d'origine.
 *
 *   2. Construction NICAD : symétrique de `assign-nicad-2026.ts` (jointure
 *      commune pour le DXF) mais résolvant Syscol ET section en une seule
 *      requête, `limite_section` portant les deux. Ne reconstruit JAMAIS un
 *      NICAD déjà valide (16 chiffres, format correct) — ne comble que les
 *      trous. N'attribue jamais de numéro de parcelle par incrémentation :
 *      si aucun numéro exploitable n'est dans les propriétés `.dbf` de la
 *      parcelle, son NICAD reste non construit (cf. `fillMissingNicadForSection`,
 *      ailleurs, pour l'attribution après coup). En cas d'incohérence de
 *      section (déclarée ≠ géolocalisée), le NICAD n'est PAS construit pour
 *      les parcelles qui n'en ont pas déjà un valide — aucune des deux
 *      valeurs de section ne fait autorité automatiquement (décision
 *      produit : l'incohérence doit être résolue manuellement).
 */
import * as turf from "@turf/turf";
import { getSectionsForPoints } from "./sections-data";
import { extractNicad } from "@/lib/geo-engine";
import { validateNicadFormat } from "./nicad-logic";
import type { FieldMapping } from "@/lib/import/field-mapping";
import { buildNicad, normalizeNumeroParcelle, codeSectionsMatch } from "@/lib/nicad";

const NUM_PARCELLE_ALIASES = ["numparcell", "num_parce", "numparce", "numparcelle"];

/** Champs canoniques enrichis depuis le mappage pour TOUTE feature, indépendamment
 *  du statut NICAD — cf. §1 du commentaire d'en-tête. `nicad`/`numParcelle` ont
 *  leur propre gestion dédiée (lecture avec priorité, construction) plus bas. */
const CANONICAL_ENRICHMENT_FIELDS = [
  "region", "departement", "commune", "quartier", "numLot", "superficie", "codeSection",
] as const;

/**
 * Extrait le numéro de parcelle des propriétés `.dbf` d'une feature, via les
 * mêmes alias que `PARCELLE_TARGET_FIELDS.numParcelle` (`field-mapping.ts`).
 *
 * Comparaison de clé INSENSIBLE À LA CASSE (`k.toLowerCase() === alias`),
 * délibérément différente du style « variantes de casse explicites » de
 * `extractNicad` (`geo-engine.ts`) : ce dernier énumère un NICAD/alias déjà
 * connu et peu nombreux à la casse prévisible. Ici, la casse réelle des
 * colonnes `.dbf` est imprévisible (Esri tronque/majuscule souvent à 10
 * caractères) — c'est exactement le problème déjà résolu par `propByAlias`
 * dans `sections-from-shapefile.ts`, dont ce helper reprend le style pour
 * rester cohérent avec le code qui traite le MÊME espace de données
 * (attributs `.dbf` de shapefile, alias `field-mapping.ts`), plutôt qu'avec
 * `extractNicad` qui traite un problème différent (une seule propriété
 * canonique connue sous quelques variantes fixes).
 *
 * `mappedColumn` (colonne mappée explicitement par l'utilisateur via
 * FieldMappingModal) est prioritaire sur ce devinage par alias : une
 * correspondance validée par l'utilisateur ne doit jamais être contournée
 * par une correspondance fortuite avec un alias générique.
 */
function extractNumParcelle(
  props: Record<string, unknown> | undefined | null,
  mappedColumn?: string,
): string | null {
  if (!props) return null;

  if (mappedColumn) {
    const raw = Object.prototype.hasOwnProperty.call(props, mappedColumn) ? props[mappedColumn] : undefined;
    if (raw != null && String(raw).trim()) {
      return normalizeNumeroParcelle(String(raw)).value;
    }
    return null;
  }

  for (const alias of NUM_PARCELLE_ALIASES) {
    const hit = Object.entries(props).find(([k]) => k.toLowerCase() === alias);
    if (hit && hit[1] != null && String(hit[1]).trim()) {
      return normalizeNumeroParcelle(String(hit[1])).value;
    }
  }
  return null;
}

function representativePoint(geometry: GeoJSON.Feature["geometry"]): [number, number] | null {
  if (!geometry) return null;
  try {
    return turf.pointOnFeature(turf.feature(geometry)).geometry.coordinates as [number, number];
  } catch {
    return null;
  }
}

/**
 * Copie, pour une feature donnée, les champs mappés par l'utilisateur
 * (hors nicad/numParcelle, gérés séparément) sous leurs clés canoniques
 * dans les propriétés. Mute `feature.properties` UNIQUEMENT si au moins un
 * champ a effectivement été copié (évite une réallocation d'objet inutile
 * pour les features sans mappage exploitable).
 */
function enrichCanonicalFields(feature: GeoJSON.Feature, fieldMapping: FieldMapping): void {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  let enriched: Record<string, unknown> | null = null;
  for (const key of CANONICAL_ENRICHMENT_FIELDS) {
    const col = fieldMapping[key];
    if (!col || !Object.prototype.hasOwnProperty.call(props, col)) continue;
    const raw = props[col];
    if (raw == null || String(raw).trim() === "") continue;
    if (!enriched) enriched = { ...props };
    enriched[key] = raw;
  }
  if (enriched) feature.properties = enriched;
}

/**
 * Mute en place TOUTES les features : enrichit leurs champs canoniques
 * (région, département, commune, quartier, n° de lot, superficie, section
 * déclarée, section géolocalisée), et construit le NICAD des features qui
 * n'en ont pas déjà un valide et dont la section ne présente pas
 * d'incohérence. Renvoie un rapport de comptage/avertissements pour le
 * résumé de job (les incohérences de section elles-mêmes sont détectées
 * séparément par `analyzeGeoJSON`, qui lit les mêmes clés canoniques pour
 * produire une erreur `section_mismatch` persistée par parcelle).
 */
export async function assignSectionNicad(
  features: GeoJSON.Feature[],
  fieldMapping?: FieldMapping,
): Promise<{
  nbConstruits: number;
  nbSansSection: number;
  nbSansNumeroParcelle: number;
  nbIncoherenceSection: number;
  warnings: string[];
}> {
  let nbConstruits = 0;
  let nbSansSection = 0;
  let nbSansNumeroParcelle = 0;
  let nbIncoherenceSection = 0;
  const warnings: string[] = [];

  // ── Enrichissement des champs canoniques : s'applique à TOUTES les
  // features, indépendamment de leur statut NICAD. ───────────────────────
  if (fieldMapping) {
    for (const feature of features) {
      enrichCanonicalFields(feature, fieldMapping);
    }
  }

  // ── Détermine, pour chaque feature avec un point représentatif
  // résolvable, si elle a déjà un NICAD valide. La résolution spatiale
  // s'applique à TOUTES ces features (pas seulement celles sans NICAD) —
  // nécessaire pour écrire `sectionGeolocalisee` même sur les parcelles
  // déjà NICADées, condition de la vérification de cohérence de section. ──
  const candidates: { index: number; point: [number, number]; hasValidNicad: boolean }[] = [];
  for (let i = 0; i < features.length; i++) {
    const props = (features[i].properties ?? {}) as Record<string, unknown>;
    const mappedNicadRaw = fieldMapping?.nicad && Object.prototype.hasOwnProperty.call(props, fieldMapping.nicad)
      ? props[fieldMapping.nicad]
      : undefined;
    const existing = mappedNicadRaw != null && String(mappedNicadRaw).trim()
      ? String(mappedNicadRaw).trim()
      : extractNicad(props);
    const hasValidNicad = !!existing && validateNicadFormat(existing).valid;
    if (hasValidNicad && props.nicad !== existing) {
      features[i].properties = { ...props, nicad: existing };
    }

    const point = representativePoint(features[i].geometry);
    if (!point) continue;
    candidates.push({ index: i, point, hasValidNicad });
  }

  if (candidates.length === 0) {
    return { nbConstruits, nbSansSection, nbSansNumeroParcelle, nbIncoherenceSection, warnings };
  }

  const matches = await getSectionsForPoints(candidates.map((c) => ({ lng: c.point[0], lat: c.point[1] })));

  let nbApprox = 0;
  candidates.forEach((c, k) => {
    const m = matches[k];
    const props = (features[c.index].properties ?? {}) as Record<string, unknown>;

    if (!m.syscolCommune || !m.numSection) {
      if (!c.hasValidNicad) nbSansSection++;
      return;
    }
    if (m.approx && !c.hasValidNicad) nbApprox++;

    const sectionGeolocalisee = `${m.syscolCommune}${m.numSection}`;
    let currentProps = props;
    if (currentProps.sectionGeolocalisee !== sectionGeolocalisee) {
      currentProps = { ...currentProps, sectionGeolocalisee };
      features[c.index].properties = currentProps;
    }

    const sectionsMatch = codeSectionsMatch(currentProps.codeSection, sectionGeolocalisee);
    if (sectionsMatch === false) {
      nbIncoherenceSection++;
    }

    if (c.hasValidNicad) return; // NICAD déjà valide : jamais reconstruit.
    if (sectionsMatch === false) return; // Incohérence : aucune section ne fait autorité automatiquement.

    const numParcelle = extractNumParcelle(currentProps, fieldMapping?.numParcelle);
    if (!numParcelle) {
      nbSansNumeroParcelle++;
      return;
    }

    const nicad = buildNicad(m.syscolCommune, m.numSection, numParcelle);
    if (nicad) {
      features[c.index].properties = { ...currentProps, nicad };
      nbConstruits++;
    }
  });

  if (nbApprox > 0) {
    warnings.push(
      `${nbApprox} parcelle(s) rattachée(s) à une section par proximité ` +
        "(point hors contenance stricte, ≤ 50 m d'une limite) — NICAD à vérifier.",
    );
  }
  if (nbSansSection > 0) {
    warnings.push(
      `${nbSansSection} parcelle(s) sans section correspondante dans limite_section ` +
        "(hors emprise du référentiel) — NICAD non construit.",
    );
  }
  if (nbSansNumeroParcelle > 0) {
    warnings.push(
      `${nbSansNumeroParcelle} parcelle(s) rattachée(s) à une section mais sans numéro de ` +
        "parcelle exploitable dans le fichier source — NICAD non construit.",
    );
  }
  if (nbIncoherenceSection > 0) {
    warnings.push(
      `${nbIncoherenceSection} parcelle(s) dont la section déclarée dans le fichier diffère de ` +
        "la section trouvée par géolocalisation — vérifier l'attribution (voir les erreurs " +
        "d'analyse « Incohérence de section »).",
    );
  }

  return { nbConstruits, nbSansSection, nbSansNumeroParcelle, nbIncoherenceSection, warnings };
}
