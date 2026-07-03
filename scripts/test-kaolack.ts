/**
 * Vérification d'ingestion sur le DXF cadastral de Kaolack (181 Mo).
 * Usage : bun scripts/test-kaolack.ts [chemin.dxf]
 */
import * as fs from "fs";
import { ingestDxfToParcelles } from "../src/lib/parcelle-ingestion";

const file =
  process.argv[2] ||
  "C:/Users/bakho/Desktop/dgig_project/data/PLAN-CADASTRAL_KAOLACK_FINAL_-11-12-2025.dxf";

async function main() {
  const t0 = Date.now();
  const buf = fs.readFileSync(file);
  console.log(`Fichier : ${file} (${(buf.length / 1e6).toFixed(1)} Mo)`);

  const { parcelles, report } = await ingestDxfToParcelles(
    buf,
    "PLAN-CADASTRAL_KAOLACK_FINAL_-11-12-2025.dxf"
  );

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Terminé en ${secs}s ===`);
  console.log(`Parcelles construites      : ${parcelles.length}`);
  console.log(`Sans numéro                : ${report.nbSansNumero}`);
  console.log(`Sans section               : ${report.nbSansSection}`);
  console.log(`Sans propriétaire          : ${report.nbSansProprietaire}`);
  console.log(`Numéros non conformes      : ${report.nbNumeroNonConforme}`);
  console.log(`Piscines                   : ${report.nbPiscines}`);
  console.log(`Polygonisées (segments)    : ${report.nbParcellesPolygonisees}`);
  console.log(`Hors emprise UTM28N        : ${report.nbHorsEmprise}`);
  console.log(`Polygones invalides        : ${report.nbPolygonesInvalidesRejetes}`);
  console.log(`Doublons géométrie         : ${report.nbDoublonsGeometrie}`);
  console.log(`Doublons recouvrement      : ${report.nbDoublonsRecouvrement}`);
  console.log(`Enveloppes supprimées      : ${report.nbEnveloppesSupprimees}`);
  console.log(`Chevauchements             : ${report.nbChevauchements}`);
  console.log(`Textes hors parcelle       : ${report.nbTextesHorsParcelle}`);
  console.log(`Surface totale (m²)        : ${report.surfaceTotaleM2.toFixed(0)}`);

  // Répartition NICAD / numéro / section
  let avecNicad = 0, avecNumero = 0, avecSection = 0, avecProp = 0;
  const secSet = new Set<string>();
  const commSet = new Set<string>();
  for (const p of parcelles) {
    if (p.nicad) avecNicad++;
    if (p.numero) avecNumero++;
    if (p.numeroSection && p.numeroSection !== "000") avecSection++;
    if (p.proprietaire) avecProp++;
    if (p.numeroSection) secSet.add(p.numeroSection);
    if (p.nomCommune2026) commSet.add(p.nomCommune2026);
  }
  console.log(`\n--- Complétude ---`);
  console.log(`Avec NICAD                 : ${avecNicad}`);
  console.log(`Avec numéro                : ${avecNumero}`);
  console.log(`Avec section (!=000)       : ${avecSection}`);
  console.log(`Avec propriétaire          : ${avecProp}`);
  console.log(`Sections distinctes        : ${secSet.size}`);
  console.log(`Communes distinctes        : ${commSet.size}`);

  console.log(`\n--- Échantillon (5 premières) ---`);
  for (const p of parcelles.slice(0, 5)) {
    console.log(
      `nicad=${p.nicad ?? "—"} | numero=${p.numero ?? "—"} | parc5=${p.numeroParcelle5 ?? "—"} | section=${p.numeroSection ?? "—"} | commune=${p.nomCommune2026 ?? "—"} | surf=${p.surfaceM2.toFixed(0)}m²`
    );
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
