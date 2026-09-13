/**
 * Genere desktop/vendor/referentiels/referentiels.sql -- dump des 4
 * referentiels administratifs statiques (cad_communes_2013, cad_communes_2026,
 * cad_arrondissements, cad_correspondance_2013_2026) depuis une base source
 * (web, deja peuplee) via `pg_dump --data-only`, pour etre rejoue au premier
 * lancement du bureau autonome (cf. docs/superpowers/specs/2026-09-13-
 * referentiels-bureau-autonome-design.md). `pg_dump` gere nativement les
 * colonnes geometrie PostGIS et les sequences (setval) -- aucun traitement
 * custom necessaire.
 *
 * Usage : npx tsx desktop/scripts/generer-referentiels.ts --url <DATABASE_URL>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TABLES = [
  "cad_communes_2013",
  "cad_communes_2026",
  "cad_arrondissements",
  "cad_correspondance_2013_2026",
];

function lireArgUrl(): string {
  const idx = process.argv.indexOf("--url");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error("Usage : npx tsx desktop/scripts/generer-referentiels.ts --url <DATABASE_URL>");
    process.exit(1);
  }
  return process.argv[idx + 1];
}

const url = lireArgUrl();
const pgDump = path.join(__dirname, "..", "vendor", "pg-portable", "bin", "pg_dump.exe");
const cheminSortie = path.join(__dirname, "..", "vendor", "referentiels", "referentiels.sql");

mkdirSync(path.dirname(cheminSortie), { recursive: true });

const morceaux: string[] = [];
for (const table of TABLES) {
  console.log(`Dump de ${table}...`);
  // maxBuffer eleve : les geometries MultiPolygon (communes/arrondissements)
  // produisent des dumps de plusieurs Mo par table, largement au-dela du
  // 1 Mo par defaut d'execFileSync.
  const sql = execFileSync(pgDump, ["--data-only", `--table=${table}`, url], {
    maxBuffer: 200 * 1024 * 1024,
  }).toString();
  morceaux.push(sql);
}

writeFileSync(cheminSortie, morceaux.join("\n"), "utf8");
console.log(`Ecrit : ${cheminSortie}`);
