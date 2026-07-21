/**
 * Exporte cad_communes_2026 en GeoJSON, pour import dans un autre projet
 * (cadex-next) qui a besoin du même référentiel de communes pour ses propres
 * jointures spatiales (NICAD, rattachement de section).
 *
 * Usage : npx tsx scripts/export-cad-communes.ts [chemin-sortie.geojson]
 */
import fs from "fs";
import { prisma } from "../src/lib/prisma";

async function main() {
  const outPath = process.argv[2] || "cad_communes_2026.geojson";

  const rows = await prisma.$queryRaw<
    Array<{
      nomCommune: string;
      region: string | null;
      departement: string | null;
      arrondissement: string | null;
      codSyscol: string;
      syscolPadded: string;
      geojson: string | null;
    }>
  >`
    SELECT "nomCommune", region, departement, arrondissement, "codSyscol", "syscolPadded",
           ST_AsGeoJSON(geom) AS geojson
    FROM "cad_communes_2026"
    WHERE geom IS NOT NULL
  `;

  const fc = {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: JSON.parse(r.geojson as string),
      properties: {
        nomCommune: r.nomCommune,
        region: r.region,
        departement: r.departement,
        arrondissement: r.arrondissement,
        codSyscol: r.codSyscol,
        syscolPadded: r.syscolPadded,
      },
    })),
  };

  fs.writeFileSync(outPath, JSON.stringify(fc));
  console.log(`${rows.length} commune(s) exportée(s) -> ${outPath}`);
}

main()
  .catch((e) => {
    console.error("Échec de l'export :", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
