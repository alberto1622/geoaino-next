/**
 * assign-section-nicad.ts — construction du NICAD des parcelles shapefile
 * (chemin page d'accueil → `Analysis`, `job.kind === "parcelles"`) par
 * jointure spatiale sur `limite_section`, symétrique de
 * `assign-nicad-2026.ts` (jointure commune pour le DXF) mais résolvant
 * Syscol ET section en une seule requête, `limite_section` portant les deux.
 *
 * Ne reconstruit JAMAIS un NICAD déjà valide (16 chiffres, format correct) —
 * ne comble que les trous. N'attribue jamais de numéro de parcelle par
 * incrémentation : si aucun numéro exploitable n'est dans les propriétés
 * `.dbf` de la parcelle, son NICAD reste non construit (cf.
 * `fillMissingNicadForSection`, ailleurs, pour l'attribution après coup).
 */
import * as turf from "@turf/turf";
import { getSectionsForPoints } from "./sections-data";
import { extractNicad } from "@/lib/geo-engine";
import { validateNicadFormat } from "./nicad-logic";
import type { FieldMapping } from "@/lib/import/field-mapping";
import { buildNicad, normalizeNumeroParcelle } from "@/lib/nicad";

const NUM_PARCELLE_ALIASES = ["numparcell", "num_parce", "numparce", "numparcelle"];

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
 */
/**
 * Colonne mappée explicitement par l'utilisateur (FieldMappingModal),
 * prioritaire sur le devinage par alias : une correspondance validée par
 * l'utilisateur ne doit jamais être contournée par une correspondance
 * fortuite avec un alias générique.
 */
function extractNumParcelle(
  props: Record<string, unknown> | undefined | null,
  mappedColumn?: string,
): string | null {
  if (!props) return null;

  if (mappedColumn) {
    const raw = props[mappedColumn];
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
 * Mute en place les features sans NICAD déjà valide : résout leur section
 * (jointure spatiale `limite_section`), construit le NICAD à partir du
 * Syscol+section de la section résolue et du numéro de parcelle propre à la
 * feature, puis renvoie un rapport de comptage/avertissements.
 */
export async function assignSectionNicad(
  features: GeoJSON.Feature[],
  fieldMapping?: FieldMapping,
): Promise<{ nbConstruits: number; nbSansSection: number; nbSansNumeroParcelle: number; warnings: string[] }> {
  let nbConstruits = 0;
  let nbSansSection = 0;
  let nbSansNumeroParcelle = 0;
  const warnings: string[] = [];

  // Ne traite que les parcelles sans NICAD déjà valide.
  const candidates: { index: number; point: [number, number] }[] = [];
  for (let i = 0; i < features.length; i++) {
    const props = (features[i].properties ?? {}) as Record<string, unknown>;
    const mappedNicadRaw = fieldMapping?.nicad ? props[fieldMapping.nicad] : undefined;
    const existing = mappedNicadRaw != null && String(mappedNicadRaw).trim()
      ? String(mappedNicadRaw).trim()
      : extractNicad(props);
    if (existing && validateNicadFormat(existing).valid) continue;

    const point = representativePoint(features[i].geometry);
    if (!point) continue;
    candidates.push({ index: i, point });
  }

  if (candidates.length === 0) {
    return { nbConstruits, nbSansSection, nbSansNumeroParcelle, warnings };
  }

  const matches = await getSectionsForPoints(candidates.map((c) => ({ lng: c.point[0], lat: c.point[1] })));

  let nbApprox = 0;
  candidates.forEach((c, k) => {
    const m = matches[k];
    if (!m.syscolCommune || !m.numSection) {
      nbSansSection++;
      return;
    }
    if (m.approx) nbApprox++;

    const props = (features[c.index].properties ?? {}) as Record<string, unknown>;
    const numParcelle = extractNumParcelle(props, fieldMapping?.numParcelle);
    if (!numParcelle) {
      nbSansNumeroParcelle++;
      return;
    }

    const nicad = buildNicad(m.syscolCommune, m.numSection, numParcelle);
    if (nicad) {
      features[c.index].properties = { ...props, nicad };
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

  return { nbConstruits, nbSansSection, nbSansNumeroParcelle, warnings };
}
