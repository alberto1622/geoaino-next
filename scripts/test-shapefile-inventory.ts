import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { buildShapefileFieldInventory } from "../src/lib/import/shapefile-inventory";

const shpPath = process.argv[2];
if (!shpPath) {
  console.log(
    "SKIP: fournir un chemin .shp en argument (ex: bun run scripts/test-shapefile-inventory.ts path/to/file.shp) " +
      "— le .dbf voisin est déduit automatiquement. Aucun fixture shapefile n'est versionné dans ce repo.",
  );
  process.exit(0);
}

const dbfPath = shpPath.replace(/\.shp$/i, ".dbf");
const shpBuf = await readFile(shpPath);
const dbfBuf = await readFile(dbfPath);

const inventory = await buildShapefileFieldInventory(shpBuf, dbfBuf, "cad-parcelles");
assert.ok(inventory.featureCount > 0, "au moins une entité attendue");
assert.ok(inventory.fields.length > 0, "au moins une colonne .dbf attendue");
assert.deepStrictEqual(
  inventory.targetFields.map((f) => f.key),
  ["nicad", "codeSection", "numParcelle", "commune", "region", "departement", "quartier", "numLot", "titreParce", "typeDocFon", "natJuri", "typeDestin", "catOcup", "superficie", "proprietaire"],
);

console.log(`OK: ${inventory.featureCount} entités, ${inventory.fields.length} colonnes, mapping proposé:`, inventory.proposedMapping);
