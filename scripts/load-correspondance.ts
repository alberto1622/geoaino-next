/**
 * Chargement de la correspondance communes 2013 -> 2026 dans geoaino_db
 * (table cad_correspondance_2013_2026 / modèle CadCorrespondance).
 *
 * Source : data/etl_verifcad/output/correspondance_2013_2026.csv
 *          (produit par data/etl_verifcad/correspondance.py — appariement spatial).
 *
 * Exécution : npx tsx scripts/load-correspondance.ts [--fresh]
 * --fresh : vide la table avant chargement.
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
const CSV_PATH = resolve(process.cwd(), "../data/etl_verifcad/output/correspondance_2013_2026.csv");
const prisma = new PrismaClient();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Parseur CSV minimal gérant les guillemets et le séparateur ';'.
function parseCsv(text: string, sep = ";"): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const vals = split(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = (vals[i] ?? "").trim()));
    return row;
  });
}

const orNull = (v: string) => (v && v !== "" ? v : null);

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL est requis.");

  let rows: Record<string, string>[];
  try {
    rows = parseCsv(readFileSync(CSV_PATH, "utf-8"));
  } catch (e) {
    throw new Error(`Impossible de lire ${CSV_PATH} — lancez d'abord correspondance.py. (${e})`);
  }
  console.log(`→ ${rows.length} correspondances lues depuis ${CSV_PATH}`);

  // Dédup sur syscol2013 (clé fonctionnelle, padStart 8).
  const bySyscol = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const s = (r.syscol2013 || "").replace(/\D/g, "").padStart(8, "0");
    if (s !== "00000000") bySyscol.set(s, { ...r, syscol2013: s });
  }
  const data = [...bySyscol.values()];

  if (FRESH) {
    console.log("→ Purge de cad_correspondance_2013_2026 …");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "cad_correspondance_2013_2026" RESTART IDENTITY CASCADE`);
  }

  let inserted = 0;
  for (const c of chunk(data, BATCH)) {
    const res = await prisma.cadCorrespondance.createMany({
      data: c.map((r) => ({
        syscol2013: r.syscol2013,
        nomCommune2013: r.nomCommune2013 ?? "",
        syscol2026: orNull((r.syscol2026 || "").replace(/\D/g, "")) ?? undefined,
        nomCommune2026: orNull(r.nomCommune2026) ?? undefined,
        region: orNull(r.region) ?? undefined,
        departement: orNull(r.departement) ?? undefined,
        statut: r.statut || "provisoire",
        notes: orNull(r.notes) ?? undefined,
      })),
      skipDuplicates: true,
    });
    inserted += res.count;
  }
  console.log(`✓ cad_correspondance_2013_2026 : ${inserted} lignes insérées`);

  const stats = await prisma.cadCorrespondance.groupBy({ by: ["statut"], _count: true });
  console.log("Répartition par statut :", stats.map((s) => `${s.statut}=${s._count}`).join(", "));
  const total = await prisma.cadCorrespondance.count();
  console.log(`✅ Chargement terminé — ${total} correspondances en base.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Échec :", e);
  await prisma.$disconnect();
  process.exit(1);
});
