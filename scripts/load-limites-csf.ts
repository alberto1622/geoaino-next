/**
 * Chargement des centres de services fiscaux (CSF, limites administratives
 * 2023, DGID) dans geoaino_db (table cad_centres_services_fiscaux) —
 * géométrie propre, chargée depuis un shapefile dédié, même contrat que
 * load-arrondissements.ts.
 *
 * Source : shapefile direct (.shp + .dbf), projection WGS_1984_UTM_Zone_28N
 * (vérifiée via le .prj) — reprojetée en WGS84 (EPSG:4326) à la volée, même
 * heuristique que load-arrondissements.ts (convertGeometryToWgs84).
 *
 * Champs .dbf attendus (Limites_CSF_2023.shp, 26 features, Polygon/MultiPolygon) :
 *   CSF (nom du centre de services fiscaux), REG (région).
 *
 * Exécution : npx tsx scripts/load-limites-csf.ts [chemin.shp] [--fresh]
 * --fresh : vide cad_centres_services_fiscaux avant chargement.
 *
 * Préalable : migration 20260918085454_add_cad_centres_services_fiscaux
 * appliquée (npx prisma migrate deploy) et client Prisma régénéré (npx prisma generate).
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
  "C:\\Users\\bakho\\Desktop\\dgig_project\\data\\limitAdmin2025\\limitAdmin2025\\Limites_CSF_2023.shp";
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
    nomCsf: string;
    region: string | null;
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
    const nomCsf = pick(props, "CSF", "NOM_CSF");
    if (!nomCsf) {
      ignores++;
      continue;
    }
    rows.push({
      nomCsf,
      region: pick(props, "REG", "REGION") || null,
      geojson: JSON.stringify(geom),
    });
  }
  console.log(`→ ${rows.length} centres exploitables (ignorés : ${ignores})`);

  if (FRESH) {
    console.log("→ Purge de cad_centres_services_fiscaux …");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "cad_centres_services_fiscaux" RESTART IDENTITY`);
  }

  let inserted = 0;
  for (const c of chunk(rows, BATCH)) {
    const res = await prisma.cadCentreServiceFiscal.createMany({ data: c });
    inserted += res.count;
  }
  console.log(`✓ cad_centres_services_fiscaux : ${inserted} lignes insérées`);

  console.log("→ Construction de la géométrie PostGIS (geom) …");
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "cad_centres_services_fiscaux"
       SET "geom" = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON("geojson"), 4326))
     WHERE "geojson" IS NOT NULL AND "geom" IS NULL`,
  );
  console.log(`  ✓ geom mis à jour (${updated} lignes)`);

  const total = await prisma.cadCentreServiceFiscal.count();
  console.log(`✅ Chargement terminé — cad_centres_services_fiscaux contient ${total} centres.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Échec du chargement :", e);
  await prisma.$disconnect();
  process.exit(1);
});
