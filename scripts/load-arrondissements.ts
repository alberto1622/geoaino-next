/**
 * Chargement des arrondissements (limites administratives 2025, DGID/DTGC)
 * dans geoaino_db (table cad_arrondissements) — géométrie propre, PAS dérivée
 * de cad_communes_2026 (contrairement à departement/region qui restent
 * dissous à la volée, cf. src/lib/cadastre/admin-boundaries.ts).
 *
 * Source : shapefile direct (.shp + .dbf), projection WGS_1984_UTM_Zone_28N
 * (vérifiée via le .prj) — reprojetée en WGS84 (EPSG:4326) à la volée, même
 * heuristique que sections-from-shapefile.ts (convertGeometryToWgs84).
 *
 * Champs .dbf attendus (Arrondissements.shp, 127 features, Polygon) :
 *   NOM_ARROND, REGION, COD_REG, DEPT, COD_DEPT, CAV, COD_CAV.
 *
 * Exécution : npx tsx scripts/load-arrondissements.ts [chemin.shp] [--fresh]
 * --fresh : vide cad_arrondissements avant chargement.
 *
 * Préalable : migration 20260818143410_add_cad_arrondissements appliquée
 * (npx prisma migrate deploy) et client Prisma régénéré (npx prisma generate).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as shapefile from "shapefile";
import { PrismaClient } from "@prisma/client";
import { convertGeometryToWgs84 } from "../src/lib/cadastre/import-data";

function loadEnv() {
  try {
    const txt = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (/^["'].*["']$/.test(val)) val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* pas de .env */
  }
}
loadEnv();

const FRESH = process.argv.includes("--fresh");
const BATCH = 500;
const DEFAULT_SHP =
  "C:\\Users\\bakho\\Desktop\\dgig_project\\data\\limitAdmin2025\\limitAdmin2025\\Arrondissements.shp";
const SHP_PATH = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || DEFAULT_SHP;
const prisma = new PrismaClient();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(props: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = props?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL est requis (Postgres cible).");

  const dbfPath = SHP_PATH.replace(/\.shp$/i, ".dbf");
  let shpBuf: Buffer, dbfBuf: Buffer;
  try {
    shpBuf = readFileSync(SHP_PATH);
    dbfBuf = readFileSync(dbfPath);
  } catch (e) {
    throw new Error(`Impossible de lire ${SHP_PATH} / ${dbfPath} (${e})`);
  }

  const source = await shapefile.read(shpBuf, dbfBuf);
  console.log(`→ ${source.features.length} features lues depuis ${SHP_PATH}`);

  const rows: {
    nomArrondissement: string;
    region: string | null;
    codeRegion: string | null;
    departement: string | null;
    codeDepartement: string | null;
    cav: string | null;
    codeCav: string | null;
    geojson: string | null;
  }[] = [];
  let ignores = 0;

  for (const f of source.features) {
    const geom = f.geometry ? convertGeometryToWgs84(f.geometry) : null;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
      ignores++;
      continue;
    }
    const props = f.properties ?? {};
    const nomArrondissement = pick(props, "NOM_ARROND", "NOM_ARR", "ARRONDISSEMENT");
    if (!nomArrondissement) {
      ignores++;
      continue;
    }
    rows.push({
      nomArrondissement,
      region: pick(props, "REGION", "REG") || null,
      codeRegion: pick(props, "COD_REG", "CODE_REG") || null,
      departement: pick(props, "DEPT", "DEPARTEMENT") || null,
      codeDepartement: pick(props, "COD_DEPT", "CODE_DEPT") || null,
      cav: pick(props, "CAV") || null,
      codeCav: pick(props, "COD_CAV", "CODE_CAV") || null,
      geojson: JSON.stringify(geom),
    });
  }
  console.log(`→ ${rows.length} arrondissements exploitables (ignorés : ${ignores})`);

  if (FRESH) {
    console.log("→ Purge de cad_arrondissements …");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "cad_arrondissements" RESTART IDENTITY`);
  }

  let inserted = 0;
  for (const c of chunk(rows, BATCH)) {
    const res = await prisma.cadArrondissement.createMany({ data: c });
    inserted += res.count;
  }
  console.log(`✓ cad_arrondissements : ${inserted} lignes insérées`);

  console.log("→ Construction de la géométrie PostGIS (geom) …");
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "cad_arrondissements"
       SET "geom" = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON("geojson"), 4326))
     WHERE "geojson" IS NOT NULL AND "geom" IS NULL`,
  );
  console.log(`  ✓ geom mis à jour (${updated} lignes)`);

  const total = await prisma.cadArrondissement.count();
  console.log(`✅ Chargement terminé — cad_arrondissements contient ${total} arrondissements.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Échec du chargement :", e);
  await prisma.$disconnect();
  process.exit(1);
});
