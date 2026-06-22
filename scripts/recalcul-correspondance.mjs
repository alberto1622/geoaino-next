// Utilitaire one-off : exécute le recalcul spatial de la correspondance 2013→2026
// (identique à recalculerCorrespondancesSpatiales dans src/lib/cadastre/data.ts).
// Sert à peupler la table hors application pour vérifier le rendu de la carte.
//   node scripts/recalcul-correspondance.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SEUIL_CONFIRME = 0.5;
const SEUIL_PROVISOIRE = 0.1;
const SEUIL_DECOUPE = 0.15;

function normNom(s) {
  if (!s) return "";
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toUpperCase();
}

async function main() {
  const pairs = await prisma.$queryRaw`
    WITH a AS (
      SELECT DISTINCT ON ("syscolPadded")
             "syscolPadded", "nomCommune", "departement", "region",
             ST_MakeValid(geom) AS geom
      FROM "cad_communes_2013" WHERE geom IS NOT NULL
      ORDER BY "syscolPadded", "id" DESC
    ),
    b AS (
      SELECT DISTINCT ON ("syscolPadded")
             "syscolPadded", "nomCommune", "departement",
             ST_MakeValid(geom) AS geom
      FROM "cad_communes_2026" WHERE geom IS NOT NULL
      ORDER BY "syscolPadded", "id" DESC
    )
    SELECT
      a."syscolPadded" AS s13,
      a."nomCommune"   AS nom13,
      a."departement"  AS dept13,
      a."region"       AS region13,
      b."syscolPadded" AS s26,
      b."nomCommune"   AS nom26,
      b."departement"  AS dept26,
      ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628))
        / NULLIF(ST_Area(ST_Transform(a.geom, 32628)), 0) AS recouvr
    FROM a
    JOIN b ON a.geom && b.geom AND ST_Intersects(a.geom, b.geom)
    WHERE ST_Area(ST_Transform(ST_Intersection(a.geom, b.geom), 32628)) > 0
  `;

  const communes2013Raw = await prisma.cadCommune2013.findMany({
    select: { syscolPadded: true, nomCommune: true, region: true, departement: true },
  });
  const communes2013 = [...new Map(communes2013Raw.map((c) => [c.syscolPadded, c])).values()];

  const parS13 = new Map();
  for (const p of pairs) {
    p.recouvr = Number(p.recouvr) || 0;
    const arr = parS13.get(p.s13) ?? [];
    arr.push(p);
    parS13.set(p.s13, arr);
  }
  const best = new Map();
  for (const [s13, arr] of parS13) best.set(s13, arr.reduce((a, b) => (b.recouvr > a.recouvr ? b : a)));
  const sourcesPar2026 = new Map();
  for (const b of best.values()) sourcesPar2026.set(b.s26, (sourcesPar2026.get(b.s26) ?? 0) + 1);

  const parType = {};
  const data = [];
  for (const c of communes2013) {
    const s13 = c.syscolPadded;
    const b = best.get(s13);
    const rec = b?.recouvr ?? 0;
    const s26 = b?.s26 ?? null;
    const nom26 = b?.nom26 ?? null;
    const dept26 = b?.dept26 ?? null;
    const frags = (parS13.get(s13) ?? []).filter((p) => p.recouvr >= SEUIL_DECOUPE);
    const nbCibles = frags.length;
    const nbSources = s26 ? sourcesPar2026.get(s26) ?? 0 : 0;
    const mn13 = normNom(c.nomCommune);
    const mn26 = normNom(nom26);
    const md13 = normNom(c.departement);
    const md26 = normNom(dept26);
    const nomIdentique = mn13 !== "" && mn13 === mn26;
    const deptChange = md26 !== "" && md13 !== md26;

    let statut;
    if (rec >= SEUIL_CONFIRME && nomIdentique) statut = "confirme";
    else if (rec >= SEUIL_PROVISOIRE) statut = "provisoire";
    else statut = "sans_correspondance";

    let typeChangement;
    if (rec < SEUIL_PROVISOIRE) typeChangement = "disparue";
    else if (nbCibles >= 2) typeChangement = "decoupe";
    else if (nbSources >= 2) typeChangement = "fusion";
    else if (deptChange) typeChangement = "rattachement_departement";
    else if (!nomIdentique) typeChangement = "renomme";
    else typeChangement = "inchange";
    parType[typeChangement] = (parType[typeChangement] ?? 0) + 1;

    const ciblesTxt = frags
      .sort((x, y) => y.recouvr - x.recouvr)
      .map((p) => `${p.s26}:${p.nom26} (${Math.round(p.recouvr * 100)}%)`)
      .join(" | ");

    data.push({
      syscol2013: s13,
      nomCommune2013: c.nomCommune,
      syscol2026: s26,
      nomCommune2026: nom26,
      region: c.region ?? null,
      departement: c.departement ?? null,
      departement2026: dept26,
      statut,
      typeChangement,
      nbCibles2026: nbCibles,
      nbSources2013: nbSources,
      cibles2026: ciblesTxt || null,
      notes: `recouvrement=${Math.round(rec * 100)}% / nom=${nomIdentique ? "identique" : "different"} / dept=${deptChange ? "change" : "idem"}`,
    });
  }

  await prisma.$transaction([
    prisma.cadCorrespondance.deleteMany({}),
    prisma.cadCorrespondance.createMany({ data }),
  ]);

  console.log(`total: ${data.length}`);
  console.log(parType);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
