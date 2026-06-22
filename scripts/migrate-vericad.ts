/**
 * ETL one-shot : migration des données du module Cadastre depuis la base
 * MySQL de vericad vers la base PostgreSQL/PostGIS de geoaino-next.
 *
 * Lit MySQL (VERICAD_MYSQL_URL) → écrit Postgres via Prisma (DATABASE_URL).
 * Les `geojson` (texte) sont convertis en colonnes PostGIS `geom` (SRID 4326).
 *
 * Exécution :
 *   1) renseigner VERICAD_MYSQL_URL et DATABASE_URL (dans .env ou l'environnement)
 *   2) npm install mysql2          (source MySQL, si absent)
 *   3) npx tsx scripts/migrate-vericad.ts [--fresh]
 *
 * Option --fresh : vide les tables cad_* avant import (réexécution propre).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import mysql from "mysql2/promise";

// ─── Chargement minimal du .env (sans dépendance dotenv) ─────────────────────
function loadEnv() {
  try {
    const txt = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (/^["'].*["']$/.test(val)) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* pas de .env : on s'appuie sur l'environnement */
  }
}
loadEnv();

const FRESH = process.argv.includes("--fresh");
const BATCH = 500;
const prisma = new PrismaClient();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function str(v: any): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

async function main() {
  const mysqlUrl = process.env.VERICAD_MYSQL_URL;
  if (!mysqlUrl) throw new Error("VERICAD_MYSQL_URL est requis (URL MySQL source de vericad).");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL est requis (Postgres cible).");

  const src = await mysql.createConnection(mysqlUrl);
  console.log("✓ Connecté à MySQL (source vericad)");

  if (FRESH) {
    console.log("→ Purge des tables cad_* …");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE
      "cad_parcelles","cad_sections","cad_nicads","cad_nicad_historique",
      "cad_operations_log","cad_correspondance_2013_2026","cad_fichiers_importes",
      "cad_communes_2013","cad_communes_2026" RESTART IDENTITY CASCADE`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function read(table: string): Promise<any[]> {
    const [rows] = await src.query(`SELECT * FROM \`${table}\``);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows as any[];
  }

  // ── Communes 2013 ──────────────────────────────────────────────────────────
  {
    const rows = await read("communes2013");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadCommune2013.createMany({
        data: c.map((r) => ({
          nomCommune: str(r.nomCommune) ?? "",
          syscol: str(r.syscol) ?? "",
          syscolPadded: str(r.syscolPadded) ?? "",
          region: str(r.region),
          departement: str(r.departement),
          cav: str(r.cav),
          superficie: num(r.superficie) ?? undefined,
          geojson: str(r.geojson),
        })),
      });
    }
    console.log(`✓ communes2013 : ${rows.length}`);
  }

  // ── Communes 2026 ──────────────────────────────────────────────────────────
  {
    const rows = await read("communes2026");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadCommune2026.createMany({
        data: c.map((r) => ({
          nomCommune: str(r.nomCommune) ?? "",
          region: str(r.region),
          departement: str(r.departement),
          cav: str(r.cav),
          arrondissement: str(r.arrondissement),
          codSyscol: str(r.codSyscol) ?? "",
          syscolPadded: str(r.syscolPadded) ?? "",
          geojson: str(r.geojson),
        })),
      });
    }
    console.log(`✓ communes2026 : ${rows.length}`);
  }

  // ── Sections ────────────────────────────────────────────────────────────────
  {
    const rows = await read("sections");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadSection.createMany({
        data: c.map((r) => ({
          syscolCommune: str(r.syscolCommune) ?? "",
          version: str(r.version) ?? "2013",
          numSection: str(r.numSection) ?? "",
          nomSection: str(r.nomSection),
          nomCommune: str(r.nomCommune),
          region: str(r.region),
          departement: str(r.departement),
          geojson: str(r.geojson),
        })),
      });
    }
    console.log(`✓ sections : ${rows.length}`);
  }

  // ── Parcelles ───────────────────────────────────────────────────────────────
  {
    const rows = await read("parcelles");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadParcelle.createMany({
        data: c.map((r) => ({
          syscolCommune: str(r.syscolCommune) ?? "",
          numSection: str(r.numSection) ?? "",
          numParcelle: str(r.numParcelle) ?? "",
          version: str(r.version) ?? "2013",
          nicad: str(r.nicad),
          statut: str(r.statut) ?? "sans_nicad",
          nomProprietaire: str(r.nomProprietaire),
          superficie: num(r.superficie) ?? undefined,
          longitude: num(r.longitude) ?? undefined,
          latitude: num(r.latitude) ?? undefined,
          geojson: str(r.geojson),
          nomCommune: str(r.nomCommune),
          region: str(r.region),
          departement: str(r.departement),
          numLot: str(r.numLot),
          titreParce: str(r.titreParce),
          typeDocFon: str(r.typeDocFon),
          natJuri: str(r.natJuri),
          typeDestin: str(r.typeDestin),
          catOcup: str(r.catOcup),
          quartier: str(r.quartier),
        })),
      });
    }
    console.log(`✓ parcelles : ${rows.length}`);
  }

  // ── NICAD ───────────────────────────────────────────────────────────────────
  {
    const rows = await read("nicads");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadNicad.createMany({
        skipDuplicates: true,
        data: c.map((r) => ({
          nicad: str(r.nicad) ?? "",
          syscol: str(r.syscol) ?? "",
          section: str(r.section) ?? "001",
          numParcelle: str(r.numParcelle) ?? "",
          version: str(r.version) ?? "2013",
          statut: str(r.statut) ?? "actif",
          nomCommune: str(r.nomCommune),
          region: str(r.region),
          departement: str(r.departement),
          longitude: num(r.longitude) ?? undefined,
          latitude: num(r.latitude) ?? undefined,
          nicadNouveau: str(r.nicadNouveau),
        })),
      });
    }
    console.log(`✓ nicads : ${rows.length}`);
  }

  // ── Historique ──────────────────────────────────────────────────────────────
  {
    const rows = await read("nicad_historique");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadNicadHistorique.createMany({
        data: c.map((r) => ({
          nicadAncien: str(r.nicadAncien) ?? "",
          nicadNouveau: str(r.nicadNouveau) ?? "",
          syscolAncien: str(r.syscolAncien) ?? "",
          syscolNouveau: str(r.syscolNouveau) ?? "",
          sectionAncienne: str(r.sectionAncienne),
          sectionNouvelle: str(r.sectionNouvelle),
          communeAncienne: str(r.communeAncienne),
          communeNouvelle: str(r.communeNouvelle),
          motif: str(r.motif),
          operationId: num(r.operationId) ?? undefined,
        })),
      });
    }
    console.log(`✓ nicad_historique : ${rows.length}`);
  }

  // ── Correspondances ─────────────────────────────────────────────────────────
  {
    const rows = await read("correspondance_2013_2026");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadCorrespondance.createMany({
        data: c.map((r) => ({
          syscol2013: str(r.syscol2013) ?? "",
          nomCommune2013: str(r.nomCommune2013) ?? "",
          syscol2026: str(r.syscol2026),
          nomCommune2026: str(r.nomCommune2026),
          region: str(r.region),
          departement: str(r.departement),
          statut: str(r.statut) ?? "provisoire",
          notes: str(r.notes),
        })),
      });
    }
    console.log(`✓ correspondances : ${rows.length}`);
  }

  // ── Journal des opérations ──────────────────────────────────────────────────
  {
    const rows = await read("operations_log");
    for (const c of chunk(rows, BATCH)) {
      await prisma.cadOperationLog.createMany({
        data: c.map((r) => ({
          typeOperation: str(r.typeOperation) ?? "verification",
          statut: str(r.statut) ?? "succes",
          description: str(r.description),
          nbTraites: num(r.nbTraites) ?? 0,
          nbSucces: num(r.nbSucces) ?? 0,
          nbEchecs: num(r.nbEchecs) ?? 0,
          details: r.details ?? undefined,
          fichierSource: str(r.fichierSource),
          fichierResultat: str(r.fichierResultat),
        })),
      });
    }
    console.log(`✓ operations_log : ${rows.length}`);
  }

  await src.end();

  // ── Conversion geojson (texte) → PostGIS geom (SRID 4326, MultiPolygon) ──────
  console.log("→ Construction des géométries PostGIS (geom) …");
  for (const table of ["cad_communes_2013", "cad_communes_2026", "cad_sections", "cad_parcelles"]) {
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}"
         SET "geom" = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON("geojson"), 4326))
       WHERE "geojson" IS NOT NULL AND "geom" IS NULL`,
    );
    console.log(`  ✓ ${table}.geom`);
  }

  console.log("✅ Migration terminée.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Échec de la migration :", e);
  await prisma.$disconnect();
  process.exit(1);
});
