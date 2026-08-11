// scripts/test-import-data-mapping.ts
import assert from "node:assert";
import { importParcellesFromFeatures, importSectionsFromFeatures } from "../src/lib/cadastre/import-data";

const emptyParcelles = await importParcellesFromFeatures([], undefined);
assert.deepStrictEqual(emptyParcelles, { nbImportes: 0, nbIgnores: 0, nbErreurs: 0, warnings: [] });

const emptySections = await importSectionsFromFeatures([], { numSectionCode: "NUM_SECT_N" });
assert.deepStrictEqual(emptySections, { nbImportes: 0, nbIgnores: 0, nbErreurs: 0, warnings: [] });

console.log("OK: importParcellesFromFeatures/importSectionsFromFeatures handle empty input without touching the DB");
