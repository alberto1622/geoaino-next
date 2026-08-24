/**
 * Exporte les limite_section d'un département en GeoJSON, pour import dans
 * un autre projet (cadex-next) qui affiche les contours de section sur sa
 * carte de génération de plans. Miroir de export-cad-communes.ts.
 *
 * Usage : npx tsx scripts/export-limite-sections.ts <departement> [chemin-sortie.geojson]
 * Exemple : npx tsx scripts/export-limite-sections.ts Dakar limite_sections_dakar.geojson
 */
import fs from "fs";

async function main() {
  const departement = process.argv[2];
  if (!departement) {
    console.error("Usage: npx tsx scripts/export-limite-sections.ts <departement> [chemin-sortie.geojson]");
    process.exit(1);
  }
  const outPath = process.argv[3] || `limite_sections_${departement.toLowerCase()}.geojson`;

  try {
    process.loadEnvFile();
  } catch {
    /* .env absent : DATABASE_URL doit déjà être dans l'environnement */
  }
  const { prisma } = await import("../src/lib/prisma");

  const rows = await prisma.$queryRaw<
    Array<{
      region: string | null;
      departement: string | null;
      commune: string | null;
      syscolCommune: string | null;
      numSection: string | null;
      surfaceM2: string | null;
      geojson: string | null;
    }>
  >`
    SELECT region, departement, commune, "syscolCommune", "numSection", "surfaceM2"::text AS "surfaceM2",
           ST_AsGeoJSON(geom) AS geojson
    FROM "limite_section"
    WHERE geom IS NOT NULL AND UPPER(departement) = UPPER(${departement})
  `;

  const fc = {
    type: "FeatureCollection",
    features: rows
      .filter((r) => r.geojson)
      .map((r) => ({
        type: "Feature",
        geometry: JSON.parse(r.geojson as string),
        properties: {
          region: r.region,
          departement: r.departement,
          commune: r.commune,
          syscolCommune: r.syscolCommune,
          numSection: r.numSection,
          surfaceM2: r.surfaceM2 ? Number(r.surfaceM2) : null,
        },
      })),
  };

  fs.writeFileSync(outPath, JSON.stringify(fc));
  console.log(`${fc.features.length} section(s) exportée(s) -> ${outPath}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Échec de l'export :", e);
  process.exitCode = 1;
});
