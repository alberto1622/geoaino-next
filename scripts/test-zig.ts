/**
 * Vérification d'ingestion sur le DXF cadastral de Ziguinchor (ZIG).
 * Usage : bun scripts/test-zig.ts [chemin.dxf]
 */
import * as fs from "fs";
import { ingestDxfToParcelles } from "../src/lib/parcelle-ingestion";

const file =
  process.argv[2] ||
  "uploads/imports/1787159667052_ZIG.dxf";

async function main() {
  const t0 = Date.now();
  const buf = fs.readFileSync(file);
  console.log(`Fichier : ${file} (${(buf.length / 1e6).toFixed(1)} Mo)`);

  const { parcelles, report } = await ingestDxfToParcelles(buf, "ZIG.dxf");

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Terminé en ${secs}s ===`);
  console.log(`Parcelles construites      : ${parcelles.length}`);
  console.log(`Polygonisées (segments)    : ${report.nbParcellesPolygonisees}`);
  console.log(`Hors emprise UTM28N        : ${report.nbHorsEmprise}`);
  console.log(`Polygones invalides        : ${report.nbPolygonesInvalidesRejetes}`);
  console.log(`Doublons géométrie         : ${report.nbDoublonsGeometrie}`);
  console.log(`Doublons recouvrement      : ${report.nbDoublonsRecouvrement}`);
  console.log(`Enveloppes supprimées      : ${report.nbEnveloppesSupprimees}`);
  console.log(`Chevauchements             : ${report.nbChevauchements}`);
  console.log(`Textes hors parcelle       : ${report.nbTextesHorsParcelle}`);
  console.log(`Surface totale (m²)        : ${report.surfaceTotaleM2.toFixed(0)}`);

  if (report.reconciliation) {
    const c = report.reconciliation;
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    console.log(`\n--- Réconciliation lecteur DXF (anti-perte) ---`);
    console.log(`Entités lues (par type)    : ${JSON.stringify(c.seen)}`);
    console.log(`Entités émises (par type)  : ${JSON.stringify(c.emitted)}`);
    console.log(`Entités écartées (par type): ${JSON.stringify(c.skipped)}`);
    console.log(`Motifs d'écart             : ${JSON.stringify(c.skipReasons)}`);
    console.log(`Total lu=${sum(c.seen)} émis=${sum(c.emitted)} écarté=${sum(c.skipped)}`);
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
