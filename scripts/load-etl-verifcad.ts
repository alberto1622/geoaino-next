/**
 * Chargement des données ETL VerifCad dans geoaino_db (PostgreSQL/PostGIS).
 *
 * Source : data/etl_verifcad/output/communes_2013_wgs84.geojson (produit par
 *          data/etl_verifcad/etl_verifcad.py).
 * Cible  : table cad_communes_2013 (modèle Prisma CadCommune2013), puis
 *          construction de la colonne PostGIS geom (SRID 4326, MultiPolygon).
 *
 * Reprend la logique de src/lib/cadastre/import-data.ts (clés Syscol / NOM_COMMUN,
 * normalisation du syscol à 8 chiffres) et le pattern de scripts/migrate-vericad.ts.
 *
 * Exécution :
 *   npx tsx scripts/load-etl-verifcad.ts [--fresh]
 *
 * --fresh : vide cad_communes_2013 avant chargement (réexécution propre).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

// ─── Chargement minimal du .env ──────────────────────────────────────────────
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
    /* pas de .env : on s'appuie sur l'environnement */
  }
}
loadEnv();

const FRESH = process.argv.includes("--fresh");
const BATCH = 500;
// Chemin du GeoJSON produit par l'ETL (relatif à la racine du repo geoaino-next).
const GEOJSON_PATH = resolve(process.cwd(), "../data/etl_verifcad/output/communes_2013_wgs84.geojson");

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
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v);
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
    throw new Error(`Impossible de lire ${GEOJSON_PATH} — lancez d'abord l'ETL python. (${e})`);
  }
  const features: any[] = fc.type === "FeatureCollection" ? fc.features : [fc]; // eslint-disable-line @typescript-eslint/no-explicit-any
  console.log(`→ ${features.length} features lues depuis ${GEOJSON_PATH}`);

  // Normalisation + déduplication sur syscolPadded (dernier gagne, comme l'upsert du module).
  const bySyscol = new Map<string, {
    nomCommune: string; syscol: string; syscolPadded: string;
    region: string | null; departement: string | null; cav: string | null;
    superficie: number | null; geojson: string | null;
  }>();
  let ignores = 0;
  for (const f of features) {
    const props = f.properties ?? {};
    const syscolRaw = pick(props, "Syscol", "SYSCOL", "syscol", "COD_SYSCOL", "COD_ENTITE");
    const syscolPadded = normalizeSyscol(syscolRaw);
    if (!syscolPadded) {
      ignores++;
      continue;
    }
    const nomCommune = pick(props, "NomCommune", "NOM_COMMUN", "NOM", "nom", "Commune", "COMMUNE");
    const sup = pick(props, "superficie", "SUPERFICIE");
    bySyscol.set(syscolPadded, {
      syscol: syscolRaw,
      syscolPadded,
      nomCommune: nomCommune || `Commune ${syscolPadded}`,
      region: pick(props, "region", "REG", "REGION") || null,
      departement: pick(props, "departement", "DEPT", "DEPARTEMENT") || null,
      cav: pick(props, "cav", "CAV") || null,
      superficie: sup ? Number(sup) : null,
      geojson: f.geometry ? JSON.stringify(f.geometry) : null,
    });
  }
  const rows = [...bySyscol.values()];
  console.log(`→ ${rows.length} communes uniques (ignorées sans syscol: ${ignores})`);

  if (FRESH) {
    console.log("→ Purge de cad_communes_2013 …");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "cad_communes_2013" RESTART IDENTITY CASCADE`);
  }

  let inserted = 0;
  for (const c of chunk(rows, BATCH)) {
    const res = await prisma.cadCommune2013.createMany({
      data: c.map((r) => ({
        nomCommune: r.nomCommune,
        syscol: r.syscol,
        syscolPadded: r.syscolPadded,
        region: r.region ?? undefined,
        departement: r.departement ?? undefined,
        cav: r.cav ?? undefined,
        superficie: r.superficie ?? undefined,
        geojson: r.geojson ?? undefined,
      })),
      skipDuplicates: true,
    });
    inserted += res.count;
  }
  console.log(`✓ cad_communes_2013 : ${inserted} lignes insérées`);

  // ── geojson (texte) → PostGIS geom (SRID 4326, MultiPolygon) ────────────────
  console.log("→ Construction de la géométrie PostGIS (geom) …");
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "cad_communes_2013"
       SET "geom" = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON("geojson"), 4326))
     WHERE "geojson" IS NOT NULL AND "geom" IS NULL`,
  );
  console.log(`  ✓ geom mis à jour (${updated} lignes)`);

  const total = await prisma.cadCommune2013.count();
  console.log(`✅ Chargement terminé — cad_communes_2013 contient ${total} communes.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Échec du chargement :", e);
  await prisma.$disconnect();
  process.exit(1);
});
