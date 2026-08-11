/**
 * field-mapping.ts — définitions des champs cibles pour le mapping shapefile
 * (variante attribut, symétrique du mapping calque→classe DXF de
 * `cadastral-filter.ts`). Les alias repris ici sont EXACTEMENT ceux déjà codés
 * en dur dans `import-data.ts` et `sections-from-shapefile.ts` (aucune perte
 * de couverture) — ils deviennent la proposition automatique affichée dans
 * `FieldMappingModal`, éditable par l'utilisateur avant de lancer le job.
 */
import { normalizeText } from "../cadastral-filter";

export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite";

export interface TargetFieldDef {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
}

/** Champ cible → nom de colonne .dbf source, validé par l'utilisateur. */
export type FieldMapping = Record<string, string>;

export const PARCELLE_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "nicad", label: "NICAD (16 caractères)", aliases: ["nicad"], required: true },
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

export const CAD_SECTION_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "numSectionCode", label: "Code section (11 chiffres, syscol+section)", aliases: ["num_sect_n"], required: true },
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
