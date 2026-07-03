/**
 * Analyse structurelle rapide d'un gros DXF (streaming, sans tout charger en
 * mémoire côté logique) : compte les types d'entités et les calques, sans
 * dérouler les blocs. Objectif : comprendre où sont les parcelles.
 * Usage : bun scripts/inspect-thies-dxf.ts [chemin.dxf]
 */
import * as fs from "fs";
import * as readline from "readline";

const file =
  process.argv[2] ||
  "uploads/imports/1782995610003_PLAN_CADASTRAL_THIES_FINAL01-10-2025.dxf";

async function main() {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let prevCode: string | null = null;
  let lineNo = 0;

  // Suivi de section
  let section: string | null = null;
  let pendingSectionName = false;

  // Comptages
  const entityTypesModel = new Map<string, number>();
  const entityTypesBlocks = new Map<string, number>();
  const layerCounts = new Map<string, number>(); // toutes sections ENTITIES + BLOCKS
  const blockNames = new Set<string>();

  let curEntityType: string | null = null;
  let expectLayerValue = false;

  // On lit paire par paire : ligne paire = code, ligne impaire = valeur
  let code: string | null = null;

  for await (const raw of rl) {
    lineNo++;
    if (lineNo % 2 === 1) {
      code = raw.trim();
      continue;
    }
    const value = raw; // valeur
    const c = code!;

    // Détection des sections
    if (c === "0" && value.trim() === "SECTION") {
      pendingSectionName = true;
      continue;
    }
    if (pendingSectionName && c === "2") {
      section = value.trim();
      pendingSectionName = false;
      continue;
    }
    if (c === "0" && value.trim() === "ENDSEC") {
      section = null;
      continue;
    }

    // Entités
    if (c === "0") {
      const t = value.trim();
      curEntityType = t;
      if (t === "BLOCK") {
        // nom de bloc arrive via code 2
      }
      if (section === "ENTITIES") {
        entityTypesModel.set(t, (entityTypesModel.get(t) ?? 0) + 1);
      } else if (section === "BLOCKS") {
        entityTypesBlocks.set(t, (entityTypesBlocks.get(t) ?? 0) + 1);
      }
      continue;
    }

    // Nom de bloc
    if (c === "2" && curEntityType === "BLOCK") {
      blockNames.add(value.trim());
      continue;
    }

    // Calque
    if (c === "8" && (section === "ENTITIES" || section === "BLOCKS")) {
      const layer = value.trim();
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
      continue;
    }
  }

  const sortDesc = (m: Map<string, number>) =>
    Array.from(m.entries()).sort((a, b) => b[1] - a[1]);

  console.log("=== Types d'entités — section ENTITIES (espace modèle) ===");
  for (const [t, n] of sortDesc(entityTypesModel)) console.log(`  ${t.padEnd(16)} ${n}`);

  console.log("\n=== Types d'entités — section BLOCKS (définitions) ===");
  for (const [t, n] of sortDesc(entityTypesBlocks)) console.log(`  ${t.padEnd(16)} ${n}`);

  console.log(`\n=== Nombre de définitions de blocs : ${blockNames.size} ===`);

  console.log("\n=== Calques (nb entités, toutes sections) ===");
  for (const [l, n] of sortDesc(layerCounts)) console.log(`  ${String(n).padStart(8)}  ${l}`);
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
