import assert from "node:assert";
import {
  PARCELLE_TARGET_FIELDS,
  LIMITE_SECTION_TARGET_FIELDS,
  proposeFieldMapping,
  targetFieldsFor,
} from "../src/lib/import/field-mapping";

// Colonnes typiques Esri (tronquées à 10 caractères, casse mixte)
const columns = ["NICAD", "Codesectio", "numParcell", "Commune", "REGION", "TitulaireD", "AutreChamp"];
const mapping = proposeFieldMapping(columns, PARCELLE_TARGET_FIELDS);

assert.strictEqual(mapping.nicad, "NICAD");
assert.strictEqual(mapping.codeSection, "Codesectio");
assert.strictEqual(mapping.numParcelle, "numParcell");
assert.strictEqual(mapping.commune, "Commune");
assert.strictEqual(mapping.region, "REGION");
assert.strictEqual(mapping.proprietaire, "TitulaireD");
assert.strictEqual(mapping.quartier, undefined, "pas de colonne quartier dans l'échantillon");

// Un seul champ requis pour la cible "sections-limite"
assert.strictEqual(targetFieldsFor("sections-limite").length, 1);
assert.strictEqual(LIMITE_SECTION_TARGET_FIELDS[0].required, true);

const sectionMapping = proposeFieldMapping(["Num_Sect_N"], LIMITE_SECTION_TARGET_FIELDS);
assert.strictEqual(sectionMapping.numSection, "Num_Sect_N");

console.log("OK: field-mapping proposal matches expected aliases");
