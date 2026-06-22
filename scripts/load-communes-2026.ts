/**
 * Chargement des communes 2025 DCAD dans geoaino_db (table cad_communes_2026).
 *
 * Source : data/etl_verifcad/output/communes_2025_wgs84.geojson
 *          (produit par data/etl_verifcad/read_mdb.py depuis la géodatabase
 *           Access "Base données_Senegal.mdb").
 * Cible  : modèle Prisma CadCommune2026, puis construction de la colonne
 *          PostGIS geom (SRID 4326, MultiPolygon).
 *
 * Mapping : NOM_COMMUN→nomCommune, REGION→region, DEPT_12→departement,
 *           CAV→cav, ARRONDISSE→arrondissement, COD_SYSCOL→codSyscol/syscolPadded.
 *
 * Exécution : npx tsx scripts/load-communes-2026.ts [--fresh]
 * --fresh : vide cad_communes_2026 avant chargement.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

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
const GEOJSON_PATH = resolve(process.cwd(), "../data/etl_verifcad/output/communes_2025_wgs84.geojson");
const prisma = new PrismaClient();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeSyscol(value: unknown): string {
  if (value === null || value === undefined) return "";
  const digits = String(value).replace(/\D/g, "");
  return digits ? digits.padStart(8, "0") : "";
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fc: any;
  try {
    fc = JSON.parse(readFileSync(GEOJSON_PATH, "utf-8"));
  } catch (e) {
    throw new Error(`Impossible de lire ${GEOJSON_PATH} — lancez d'abord read_mdb.py. (${e})`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const features: any[] = fc.type === "FeatureCollection" ? fc.features : [fc];
  console.log(`→ ${features.length} features lues depuis ${GEOJSON_PATH}`);

  const bySyscol = new Map<string, {
    nomCommune: string; codSyscol: string; syscolPadded: string;
    region: string | null; departement: string | null; cav: string | null;
    arrondissement: string | null; geojson: string | null;
  }>();
  let ignores = 0;
  for (const f of features) {
    const props = f.properties ?? {};
    const codSyscol = pick(props, "COD_SYSCOL", "codSyscol", "Syscol", "SYSCOL");
    const syscolPadded = normalizeSyscol(codSyscol);
    if (!syscolPadded) {
      ignores++;
      continue;
    }
    const nomCommune = pick(props, "NOM_COMMUN", "CCRCA", "NomCommune", "NOM");
    bySyscol.set(syscolPadded, {
      codSyscol: codSyscol,
      syscolPadded,
      nomCommune: nomCommune || `Commune ${syscolPadded}`,
      region: pick(props, "REGION", "REG") || null,
      departement: pick(props, "DEPT_12", "DEPT", "DEPARTEMENT") || null,
      cav: pick(props, "CAV") || null,
      arrondissement: pick(props, "ARRONDISSE", "ARRONDISSEMENT") || null,
      geojson: f.geometry ? JSON.stringify(f.geometry) : null,
    });
  }
  const rows = [...bySyscol.values()];
  console.log(`→ ${rows.length} communes uniques (ignorées sans syscol: ${ignores})`);

  if (FRESH) {
    console.log("→ Purge de cad_communes_2026 …");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "cad_communes_2026" RESTART IDENTITY CASCADE`);
  }

  let inserted = 0;
  for (const c of chunk(rows, BATCH)) {
    const res = await prisma.cadCommune2026.createMany({
      data: c.map((r) => ({
        nomCommune: r.nomCommune,
        codSyscol: r.codSyscol,
        syscolPadded: r.syscolPadded,
        region: r.region ?? undefined,
        departement: r.departement ?? undefined,
        cav: r.cav ?? undefined,
        arrondissement: r.arrondissement ?? undefined,
        geojson: r.geojson ?? undefined,
      })),
      skipDuplicates: true,
    });
    inserted += res.count;
  }
  console.log(`✓ cad_communes_2026 : ${inserted} lignes insérées`);

  console.log("→ Construction de la géométrie PostGIS (geom) …");
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "cad_communes_2026"
       SET "geom" = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON("geojson"), 4326))
     WHERE "geojson" IS NOT NULL AND "geom" IS NULL`,
  );
  console.log(`  ✓ geom mis à jour (${updated} lignes)`);

  const total = await prisma.cadCommune2026.count();
  console.log(`✅ Chargement terminé — cad_communes_2026 contient ${total} communes.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Échec du chargement :", e);
  await prisma.$disconnect();
  process.exit(1);
});
