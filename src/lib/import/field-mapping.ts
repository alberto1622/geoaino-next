/**
 * field-mapping.ts — définitions des champs cibles pour le mapping shapefile
 * (variante attribut, symétrique du mapping calque→classe DXF de
 * `cadastral-filter.ts`). Les alias repris ici sont EXACTEMENT ceux déjà codés
 * en dur dans `import-data.ts` et `sections-from-shapefile.ts` (aucune perte
 * de couverture) — ils deviennent la proposition automatique affichée dans
 * `FieldMappingModal`, éditable par l'utilisateur avant de lancer le job.
 */
import { normalizeText } from "../cadastral-filter";

export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite" | "parcelles-home";

export interface TargetFieldDef {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
}

/** Champ cible → nom de colonne .dbf source, validé par l'utilisateur. */
export type FieldMapping = Record<string, string>;

export const PARCELLE_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "nicad", label: "NICAD (16 caractères)", aliases: ["nicad"] },
  { key: "codeSection", label: "Code section (11 chiffres, syscol+section)", aliases: ["codesectio", "cod_sect"] },
  { key: "numParcelle", label: "N° de parcelle", aliases: ["numparcell", "num_parce", "numparce", "numparcelle"] },
  { key: "commune", label: "Commune", aliases: ["commune", "nomcommune", "nom_commun", "nom"] },
  { key: "region", label: "Région", aliases: ["region"] },
  { key: "departement", label: "Département", aliases: ["departemen", "departement"] },
  { key: "quartier", label: "Quartier", aliases: ["quartier", "nom_quart"] },
  { key: "numLot", label: "N° de lot", aliases: ["numlot", "num_lot"] },
  { key: "titreParce", label: "Dénomination (titre)", aliases: ["titreparce", "titre_parc"] },
  { key: "typeDocFon", label: "Type de document foncier", aliases: ["typedocfon", "type_doc", "typedoc"] },
  { key: "natJuri", label: "Nature juridique", aliases: ["natjuri", "nat_juri"] },
  { key: "typeDestin", label: "Type de destination", aliases: ["typedestin", "type_dest", "typedest"] },
  { key: "catOcup", label: "Catégorie d'occupation", aliases: ["catocup", "cat_ocup"] },
  { key: "superficie", label: "Superficie", aliases: ["suplegale", "supreelle", "superficie", "shape_area"] },
  { key: "proprietaire", label: "Propriétaire", aliases: ["titulaired", "occupant", "nomproprietaire"] },
];

/**
 * Cibles de mappage pour le chemin shapefile de la page d'accueil
 * (job.kind === "parcelles" → Analysis.geoJsonData). Contrairement à
 * PARCELLE_TARGET_FIELDS (15 champs, colonnes DB typées de cad_parcelles),
 * ce chemin conserve TOUTES les propriétés .dbf telles quelles dans le
 * GeoJSON — les 9 champs ci-dessous sont EN PLUS copiés sous leurs clés
 * canoniques dans les propriétés (cf. `assignSectionNicad`,
 * `enrichCanonicalFields`), sans supprimer les colonnes .dbf brutes.
 *
 * `nicad`/`numParcelle` gardent leur rôle historique (devinage par alias en
 * repli, construction du NICAD). Les 7 autres (region, departement, commune,
 * quartier, numLot, superficie, codeSection) reprennent VERBATIM les
 * définitions de PARCELLE_TARGET_FIELDS (mêmes clés/alias) — aucune
 * divergence de couverture entre les deux chemins d'import shapefile.
 * `codeSection` (11 chiffres, syscol+section) alimente la vérification de
 * cohérence de section : comparé à `sectionGeolocalisee` (trouvé par
 * jointure spatiale) dans `analyzeGeoJSON` (geo-engine.ts) — désaccord =
 * nouvelle erreur d'analyse `section_mismatch`.
 */
export const PARCELLES_HOME_TARGET_FIELDS: TargetFieldDef[] = [
  {
    key: "nicad",
    label: "NICAD (16 caractères)",
    aliases: ["nicad", "nic", "num_nicad", "code_nicad", "codif"],
  },
  { key: "numParcelle", label: "N° de parcelle", aliases: ["numparcell", "num_parce", "numparce", "numparcelle"] },
  { key: "region", label: "Région", aliases: ["region"] },
  { key: "departement", label: "Département", aliases: ["departemen", "departement"] },
  { key: "commune", label: "Commune", aliases: ["commune", "nomcommune", "nom_commun", "nom"] },
  { key: "quartier", label: "Quartier", aliases: ["quartier", "nom_quart"] },
  { key: "numLot", label: "N° de lot", aliases: ["numlot", "num_lot"] },
  { key: "superficie", label: "Superficie", aliases: ["suplegale", "supreelle", "superficie", "shape_area"] },
  { key: "codeSection", label: "Code section (11 chiffres, syscol+section)", aliases: ["codesectio", "cod_sect"] },
];

export const CAD_SECTION_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "numSectionCode", label: "Code section (11 chiffres, syscol+section)", aliases: ["num_sect_n"] },
  { key: "nomSection", label: "Nom de la section", aliases: ["nom_sect", "nomsect", "nom_section", "nomsection", "name"] },
  { key: "nomCommune", label: "Commune", aliases: ["com_arrond", "nomcommune", "nom_commun", "nom"] },
  { key: "region", label: "Région", aliases: ["region"] },
  { key: "departement", label: "Département/Arrondissement", aliases: ["arrondisse", "departement"] },
];

export const LIMITE_SECTION_TARGET_FIELDS: TargetFieldDef[] = [
  {
    key: "numSection",
    label: "Numéro de section",
    aliases: ["num_sect_n", "num_sectio", "num_sect", "numsect", "numsection", "num_section", "section"],
    required: true,
  },
];

export function targetFieldsFor(target: ShapefileTarget): TargetFieldDef[] {
  if (target === "cad-parcelles") return PARCELLE_TARGET_FIELDS;
  if (target === "cad-sections") return CAD_SECTION_TARGET_FIELDS;
  if (target === "parcelles-home") return PARCELLES_HOME_TARGET_FIELDS;
  return LIMITE_SECTION_TARGET_FIELDS;
}

/** Propose un mappage champ cible → colonne .dbf par correspondance exacte (nom normalisé, insensible à la casse). */
export function proposeFieldMapping(
  availableColumns: string[],
  targetFields: TargetFieldDef[],
): FieldMapping {
  const byNormalized = new Map<string, string>();
  for (const col of availableColumns) {
    const key = normalizeText(col).replace(/ /g, "");
    if (!byNormalized.has(key)) byNormalized.set(key, col);
  }
  const mapping: FieldMapping = {};
  for (const field of targetFields) {
    for (const alias of field.aliases) {
      const hit = byNormalized.get(normalizeText(alias).replace(/ /g, ""));
      if (hit) {
        mapping[field.key] = hit;
        break;
      }
    }
  }
  return mapping;
}
