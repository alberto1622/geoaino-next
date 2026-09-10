/**
 * Vérifications du module « Vérifier des bornes » (src/lib/cadastre/verif).
 * Le projet n'a pas de framework de test : script tsx, sur le modèle des
 * autres `scripts/*.ts` (cf. la spec source, § 10).
 *
 * Usage : npx tsx scripts/test-verif.ts    (ou : npm run test:verif)
 *
 * Points 1 à 4 et 6 du § 10 de la spec cadex-next, adaptés :
 *  1. aller-retour sur une vraie CadParcelle (si la base en contient une
 *     exploitable) — format → parse → verifier, l'aire retombe sur le shoelace ;
 *  2. parsing tolérant ;
 *  3. un cas par code d'anomalie + un cas propre ;
 *  4. corrections PERMUTER_XY / DIVISER_1000 ;
 *  6. tolérance de superficie (limite, > T, > 2T, plancher).
 */
import { prisma } from "../src/lib/prisma";
import { parseBornes, formaterBornes } from "../src/lib/cadastre/verif/parse";
import { verifier, appliquerCorrection } from "../src/lib/cadastre/verif/core";
import { bornesDuReferentiel } from "../src/lib/cadastre/verif/referentiel";
import type { Borne, CodeAnomalie } from "../src/lib/cadastre/verif/types";

let ok = 0;
let ko = 0;

function check(nom: string, condition: boolean, detail?: string) {
  if (condition) {
    ok++;
    console.log(`  ✓ ${nom}`);
  } else {
    ko++;
    console.error(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Shoelace sur des bornes projetées (aire non signée). */
function aire(bornes: Borne[]): number {
  let s = 0;
  for (let i = 0; i < bornes.length; i++) {
    const a = bornes[i];
    const b = bornes[(i + 1) % bornes.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

// Carré de 100 m de côté, coin sud-ouest à (500000, 1600000), sens horaire
// (B1 = nord). Aire = 10 000 m².
const CARRE: Borne[] = [
  { pt: "B1", x: 500000, y: 1600100 },
  { pt: "B2", x: 500100, y: 1600100 },
  { pt: "B3", x: 500100, y: 1600000 },
  { pt: "B4", x: 500000, y: 1600000 },
];

const aCode = (codes: readonly { code: CodeAnomalie }[], c: CodeAnomalie) =>
  codes.some((a) => a.code === c);

// --- 1. Aller-retour sur une vraie parcelle ---------------------------------

async function testAllerRetour() {
  console.log("\n[1] Aller-retour sur une CadParcelle réelle");
  const candidat = await prisma.cadParcelle.findFirst({
    where: { nicad: { not: null }, geojson: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  if (!candidat?.nicad) {
    console.log("  (aucune CadParcelle avec NICAD + géométrie en base — étape ignorée)");
    return;
  }

  const ref = await bornesDuReferentiel(candidat.nicad);
  if (!ref || ref.bornes.length < 3) {
    console.log(`  (NICAD ${candidat.nicad} sans anneau exploitable — étape ignorée)`);
    return;
  }

  const attendue = aire(ref.bornes);
  const texte = formaterBornes(ref.bornes);
  const { bornes: reparsees, erreurs } = parseBornes(texte);
  check("le tableau formaté se re-parse sans erreur", erreurs.length === 0, `${erreurs.length} erreur(s)`);
  check(
    "toutes les bornes sont retrouvées",
    reparsees.length === ref.bornes.length,
    `${reparsees.length} vs ${ref.bornes.length}`,
  );

  const rap = verifier({ bornes: reparsees, crsSource: "EPSG:32628" });
  const rel = Math.abs(rap.superficieM2 - attendue) / attendue;
  check(
    `superficie stable après format/parse (écart relatif ${rel.toExponential(2)})`,
    rel < 1e-4,
    `calculée ${rap.superficieM2.toFixed(3)} vs ${attendue.toFixed(3)}`,
  );
  check("géométrie WGS84 produite", rap.geometry !== null);
}

// --- 2. Parsing ------------------------------------------------------------

function testParsing() {
  console.log("\n[2] Parsing tolérant");

  const tsv = "Pts\tX (m)\tY (m)\nB1\t240123.4567\t1630987.6543\nB2\t240200.5\t1631000.25\nB3\t240250\t1630900\nSystème de coordonnée : RRS04";
  check("TSV + en-tête + pied RRS04", parseBornes(tsv).bornes.length === 3);

  const csvVirguleDecimale = "1;240123,4567;1630987,6543\n2;240200,5;1631000,25\n3;240250;1630900";
  check("« ; » séparateur, virgule décimale", parseBornes(csvVirguleDecimale).bornes.length === 3);

  const csvVirguleColonne = "240123.45,1630987.65\n240200.50,1631000.25\n240250,1630900";
  check("virgule séparateur de colonnes (pas de ; ni tab)", parseBornes(csvVirguleColonne).bornes.length === 3);

  const NBSP = String.fromCharCode(0x00a0); // espace insecable (separateur de milliers)
  const espacesFins =
    "B1\t240" + NBSP + "123.45\t1" + NBSP + "630" + NBSP + "987.65\n" +
    "B2\t240" + NBSP + "200\t1" + NBSP + "631" + NBSP + "000\n" +
    "B3\t240" + NBSP + "250\t1" + NBSP + "630" + NBSP + "900";
  check("espaces fines de milliers absorbées", parseBornes(espacesFins).bornes.length === 3);

  const prefixes = "S1 240123 1630987\nP2 240200 1631000\n3- 240250 1630900";
  check("préfixes B1/S1/P1/1 libres", parseBornes(prefixes).bornes.length === 3);

  const avecVides = "\n\nB1 240123 1630987\n\nB2 240200 1631000\n\n";
  check("lignes vides ignorées", parseBornes(avecVides).bornes.length === 2);

  // Bloc tabulé -> la virgule est décimale ; « 12,34,56 » (deux virgules) reste
  // illisible et doit produire une ErreurLigne, pas un silence.
  const avecFautive = "B1\t240123\t1630987\nB2\t12,34,56\tnope\nB3\t240250\t1630900";
  const r = parseBornes(avecFautive);
  check(
    "ligne illisible signalée, pas silencieuse",
    r.bornes.length === 2 && r.erreurs.length === 1,
    `${r.bornes.length} bornes / ${r.erreurs.length} erreurs`,
  );

  const rt = parseBornes(formaterBornes(CARRE));
  check("aller-retour formaterBornes/parseBornes", rt.bornes.length === 4 && rt.erreurs.length === 0);
}

// --- 3. Un cas par code d'anomalie + un cas propre -----------------------

function testAnomalies() {
  console.log("\n[3] Contrôles (un cas par anomalie)");

  check("cas propre : aucune anomalie", verifier({ bornes: CARRE, crsSource: "EPSG:32628" }).anomalies.length === 0);

  check(
    "BORNES_INSUFFISANTES",
    aCode(verifier({ bornes: CARRE.slice(0, 2), crsSource: "EPSG:32628" }).anomalies, "BORNES_INSUFFISANTES"),
  );

  // Noeud papillon : B3 et B4 croisés.
  const papillon: Borne[] = [
    { pt: "B1", x: 500000, y: 1600100 },
    { pt: "B2", x: 500100, y: 1600100 },
    { pt: "B3", x: 500000, y: 1600000 },
    { pt: "B4", x: 500100, y: 1600000 },
  ];
  check("AUTO_INTERSECTION", aCode(verifier({ bornes: papillon, crsSource: "EPSG:32628" }).anomalies, "AUTO_INTERSECTION"));

  const inverses = CARRE.map((b) => ({ ...b, x: b.y, y: b.x }));
  check("XY_INVERSES", aCode(verifier({ bornes: inverses, crsSource: "EPSG:32628" }).anomalies, "XY_INVERSES"));

  const km = CARRE.map((b) => ({ ...b, x: b.x * 1000, y: b.y * 1000 }));
  check("UNITE_SUSPECTE", aCode(verifier({ bornes: km, crsSource: "EPSG:32628" }).anomalies, "UNITE_SUSPECTE"));

  const horsEmprise = CARRE.map((b) => ({ ...b, x: b.x + 5_000_000 }));
  check("HORS_EMPRISE", aCode(verifier({ bornes: horsEmprise, crsSource: "EPSG:32628" }).anomalies, "HORS_EMPRISE"));

  const confondues: Borne[] = [
    ...CARRE,
    { pt: "B5", x: 500000.005, y: 1600000.005 },
  ];
  check("BORNES_CONFONDUES", aCode(verifier({ bornes: confondues, crsSource: "EPSG:32628" }).anomalies, "BORNES_CONFONDUES"));

  const colineaire: Borne[] = [
    { pt: "B1", x: 500000, y: 1600100 },
    { pt: "B2", x: 500050, y: 1600100 }, // sur le segment B1–B3
    { pt: "B3", x: 500100, y: 1600100 },
    { pt: "B4", x: 500100, y: 1600000 },
    { pt: "B5", x: 500000, y: 1600000 },
  ];
  check("BORNE_COLINEAIRE", aCode(verifier({ bornes: colineaire, crsSource: "EPSG:32628" }).anomalies, "BORNE_COLINEAIRE"));

  // Numérotation ne démarrant pas au Y max (B1 au sud).
  const malNumerote: Borne[] = [
    { pt: "B1", x: 500000, y: 1600000 },
    { pt: "B2", x: 500100, y: 1600000 },
    { pt: "B3", x: 500100, y: 1600100 },
    { pt: "B4", x: 500000, y: 1600100 },
  ];
  check(
    "NUMEROTATION_NON_CONFORME",
    aCode(verifier({ bornes: malNumerote, crsSource: "EPSG:32628" }).anomalies, "NUMEROTATION_NON_CONFORME"),
  );

  check(
    "ECART_SUPERFICIE",
    aCode(
      verifier({ bornes: CARRE, crsSource: "EPSG:32628", superficieDeclaree: 9000 }).anomalies,
      "ECART_SUPERFICIE",
    ),
  );
}

// --- 4. Corrections -----------------------------------------------------

function testCorrections() {
  console.log("\n[4] Corrections");

  const inverses = CARRE.map((b) => ({ ...b, x: b.y, y: b.x }));
  const apresPermut = verifier({
    bornes: appliquerCorrection(inverses, "PERMUTER_XY"),
    crsSource: "EPSG:32628",
  });
  check("PERMUTER_XY → CONFORME", apresPermut.verdict === "CONFORME", apresPermut.verdict);

  const km = CARRE.map((b) => ({ ...b, x: b.x * 1000, y: b.y * 1000 }));
  const apresDiv = verifier({
    bornes: appliquerCorrection(km, "DIVISER_1000"),
    crsSource: "EPSG:32628",
  });
  check("DIVISER_1000 → CONFORME", apresDiv.verdict === "CONFORME", apresDiv.verdict);
}

// --- 6. Tolérance de superficie -----------------------------------------

function testTolerance() {
  console.log("\n[6] Tolérance de superficie (aire réelle = 10 000 m²)");

  // Déclarée 10 000, tolerancePct 0.5 % → T = max(50, 1) = 50 m².
  const dansTol = verifier({ bornes: CARRE, crsSource: "EPSG:32628", superficieDeclaree: 10040 });
  check("écart < T : pas d'anomalie", !aCode(dansTol.anomalies, "ECART_SUPERFICIE"));

  const avert = verifier({ bornes: CARRE, crsSource: "EPSG:32628", superficieDeclaree: 10080 });
  const aAvert = avert.anomalies.find((a) => a.code === "ECART_SUPERFICIE");
  check("T < écart ≤ 2T : avertissement", aAvert?.severite === "avertissement", aAvert?.severite);

  const err = verifier({ bornes: CARRE, crsSource: "EPSG:32628", superficieDeclaree: 10200 });
  const aErr = err.anomalies.find((a) => a.code === "ECART_SUPERFICIE");
  check("écart > 2T : erreur", aErr?.severite === "erreur", aErr?.severite);

  // Petite parcelle : plancher 1 m². Triangle ~50 m².
  const triangle: Borne[] = [
    { pt: "B1", x: 500000, y: 1600010 },
    { pt: "B2", x: 500010, y: 1600000 },
    { pt: "B3", x: 500000, y: 1600000 },
  ];
  const aireTri = aire(triangle); // 50
  // Déclarée = aire + 0.75 → sous le plancher de 1 m² : pas d'anomalie.
  const sousPlancher = verifier({
    bornes: triangle,
    crsSource: "EPSG:32628",
    superficieDeclaree: aireTri + 0.75,
  });
  check("petite parcelle, écart < plancher (1 m²) : pas d'anomalie", !aCode(sousPlancher.anomalies, "ECART_SUPERFICIE"));
}

async function main() {
  await testAllerRetour();
  testParsing();
  testAnomalies();
  testCorrections();
  testTolerance();

  console.log(`\n${ok} assertion(s) OK, ${ko} en échec.`);
  await prisma.$disconnect();
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
