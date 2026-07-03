/**
 * Test d'ingestion sur un gros DXF (vérifie le correctif de troncature).
 * Usage : bun scripts/test-keur-massar.ts [chemin.dxf]
 */
import * as fs from "fs";
import { ingestDxfToParcelles } from "../src/lib/parcelle-ingestion";

const file = process.argv[2] || "C:/Users/bakho/Desktop/dgig_project/data/KEUR_MASSAR.dxf";

async function main() {
  const t0 = Date.now();
  const buf = fs.readFileSync(file);
  console.log(`Fichier : ${file} (${(buf.length / 1e6).toFixed(1)} Mo)`);

  const { parcelles, report } = await ingestDxfToParcelles(buf, "KEUR_MASSAR.dxf");

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

  console.log(`\n--- Échantillon (5 premières parcelles) ---`);
  for (const p of parcelles.slice(0, 5)) {
    console.log(
      `numero=${p.numero ?? "—"} | parc5=${p.numeroParcelle5 ?? "—"} | section=${p.numeroSection ?? "—"} | lot=${p.numeroLot ?? "—"} | prop=${(p.proprietaire ?? "—").slice(0, 30)} | surf=${p.surfaceM2.toFixed(0)}m²`
    );
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
