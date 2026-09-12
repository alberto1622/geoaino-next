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
import path from "node:path";
import { existsSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { prisma } from "../src/lib/prisma";
import { parseBornes, formaterBornes } from "../src/lib/cadastre/verif/parse";
import { verifier, appliquerCorrection } from "../src/lib/cadastre/verif/core";
import { bornesDuReferentiel } from "../src/lib/cadastre/verif/referentiel";
import { extraireTextePdf, lireMetaPlan } from "../src/lib/cadastre/verif/pdfTexte";
import {
  extraireTexteParPosition,
  isolerBlocTableau,
} from "../src/lib/cadastre/verif/pdfTableauTexte";
import { ocrTableauCoordonnees, ocrImageCoordonnees } from "../src/lib/cadastre/verif/ocr";
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

// --- 7. Import PDF : lecture de la couche texte -------------------------

async function testPdfTexte() {
  console.log("\n[7] Import PDF — couche texte (pdf-lib)");

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Métadonnées + tableau de coordonnées, chacun dans son propre drawText
  // (donc son propre bloc BT…ET, comme sur un plan réel).
  // NICAD/superficie sur un vrai plan : le libellé et la valeur sont deux
  // blocs de texte distincts (deux drawText, donc deux chaînes BT…ET) —
  // lireMetaPlan() reconnaît la valeur par sa FORME, jamais par un libellé
  // collé devant. On reproduit donc ce découpage, pas une phrase unique.
  page.drawText("NICAD", { x: 40, y: 800, size: 8, font });
  page.drawText("014020030012345", { x: 100, y: 800, size: 10, font });
  page.drawText("Superficie", { x: 40, y: 780, size: 8, font });
  page.drawText("500.00 m2", { x: 100, y: 780, size: 10, font });
  const table = [
    "Pts X Y",
    "B1 500000.0000 1600100.0000",
    "B2 500100.0000 1600100.0000",
    "B3 500100.0000 1600000.0000",
    "B4 500000.0000 1600000.0000",
  ];
  table.forEach((ligne, i) => {
    page.drawText(ligne, { x: 40, y: 740 - i * 16, size: 9, font });
  });

  const pdf = Buffer.from(await doc.save());
  const chaines = await extraireTextePdf(pdf);
  check("des chaînes de texte sont extraites du PDF", chaines.length > 0, `${chaines.length}`);

  const joint = chaines
    .join("\n")
    .replace(/\bB\s*(\d)/g, "\nB$1")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  const { bornes, erreurs } = parseBornes(joint);
  check(
    "les 4 bornes du tableau texte sont retrouvées",
    bornes.length === 4,
    `${bornes.length} bornes / ${erreurs.length} erreurs`,
  );

  const meta = lireMetaPlan(chaines);
  check("le NICAD est lu dans la couche texte", meta.nicad === "014020030012345", meta.nicad);
  check("la superficie est lue dans la couche texte", meta.superficieM2 === 500, String(meta.superficieM2));

  if (bornes.length === 4) {
    const rap = verifier({ bornes, crsSource: "EPSG:32628", superficieDeclaree: meta.superficieM2 });
    check("le rapport se calcule sur les bornes extraites", rap.geometry !== null && rap.superficieM2 > 0);
  }
}

// --- 8. Import PDF : couche texte reconstruite PAR POSITION (tableau cellule par cellule) ---

/**
 * Garde-fou contre la régression signalée par l'utilisateur : « bornes
 * manquantes, en trop, ou mal ordonnées » après import d'un plan PDF dont le
 * tableau est du texte. La voie [7] ci-dessus dessine chaque LIGNE comme une
 * seule chaîne — trop optimiste : la plupart des générateurs PDF dessinent
 * chaque CELLULE séparément (Pts, X, Y en trois `drawText`), et leur ordre de
 * DESSIN ne suit pas forcément l'ordre de LECTURE. Ce cas-ci reproduit
 * exactement ça et vérifie que la reconstruction par position (pdfTableauTexte.ts)
 * retrouve les bonnes bornes, dans le bon ordre — là où l'ancienne extraction
 * par ordre de dessin échoue (testé manuellement : 0 borne retrouvée).
 */
async function testPdfTableauParPosition() {
  console.log("\n[9] Import PDF — tableau reconstruit par position (cellule par cellule)");

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText("PLAN DE MORCELLEMENT", { x: 40, y: 800, size: 16, font: fontB });
  page.drawText("NICAD", { x: 40, y: 770, size: 8, font });
  page.drawText("014020030012345", { x: 100, y: 770, size: 10, font });

  // Chaque cellule (Pts / X / Y) est un drawText séparé, alignée par colonne
  // — pas "B1 240123.4567 1630987.6543" en une seule chaîne.
  const COL_PT = 40;
  const COL_X = 100;
  const COL_Y = 220;
  const lignesTable: [string, string, string][] = [
    ["Pts", "X (m)", "Y (m)"],
    ["B1", "240123.4567", "1630987.6543"],
    ["B2", "240200.5000", "1631000.2500"],
    ["B3", "240250.0000", "1630900.0000"],
    ["B4", "240100.0000", "1630850.0000"],
  ];
  let y = 700;
  for (const [pt, x, yy] of lignesTable) {
    page.drawText(pt, { x: COL_PT, y, size: 10, font });
    page.drawText(x, { x: COL_X, y, size: 10, font });
    page.drawText(yy, { x: COL_Y, y, size: 10, font });
    y -= 20;
  }
  const pdf = Buffer.from(await doc.save());

  const parPosition = await extraireTexteParPosition(pdf);
  check("l'extraction par position aboutit (pdfjs-dist disponible)", parPosition !== null);
  if (!parPosition) return;

  const { bornes, erreurs } = parseBornes(parPosition);
  check(
    "les 4 bornes cellule-par-cellule sont retrouvées, dans l'ordre",
    bornes.length === 4 &&
      bornes.every((b, i) => b.pt === `B${i + 1}`) &&
      bornes[1].x === 240200.5 &&
      bornes[1].y === 1631000.25,
    `${bornes.length} bornes / ${erreurs.length} erreurs : ${JSON.stringify(bornes)}`,
  );
}

// --- 10. Import PDF : cartouche du plan pris pour une borne ------------

/**
 * Garde-fou contre la régression signalée par l'utilisateur : « 1 borne sort
 * de l'emprise du Sénégal en UTM 28N » à la vérification d'un plan dont le
 * tableau est pourtant parfaitement lu.
 *
 * `parseBornes` était appliqué à TOUT le texte de la page, alors qu'il est
 * écrit pour un tableau seul : toute ligne du cartouche portant deux jetons
 * numériques devenait une borne. Le coupable sur un plan Morcellement CADEX
 * est l'échelle du plan de situation, « 10 000 » — deux jetons une fois
 * découpée sur l'espace (qui est un séparateur de colonnes, pas de milliers,
 * cf. `ESPACES_MILLIERS`), donc une borne fantôme en (10 ; 0).
 *
 * Le tableau doit être ISOLÉ du reste de la page avant parsing.
 */
async function testPdfCartouche() {
  console.log("\n[10] Import PDF — le cartouche ne doit pas produire de bornes");

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Cartouche d'un plan Morcellement réel, au-dessus du tableau.
  const cartouche: [string, number, number][] = [
    ["012345678901", 450, 655], // NICAD
    ["3561.87 m²", 500, 625], // superficie
    ["10 000", 160, 485], // échelle du plan de situation — le coupable
    ["11/09/2026", 107, 143], // date
    ["1000", 334, 19], // échelle du plan
  ];
  for (const [t, x, y] of cartouche) page.drawText(t, { x, y, size: 10, font });

  // Tableau, cellule par cellule, en-tête et pied compris.
  const BORNES: [string, string, string][] = [
    ["B1", "284650.1541", "1626132.3434"],
    ["B2", "284692.0447", "1626118.6919"],
    ["B3", "284681.8798", "1626065.6607"],
    ["B4", "284627.0047", "1626072.7871"],
    ["B5", "284617.6048", "1626106.0712"],
  ];
  let y = 310;
  for (const [pt, x, yy] of [["Pts", "X (m)", "Y (m)"] as [string, string, string], ...BORNES]) {
    page.drawText(pt, { x: 45, y, size: 8, font });
    page.drawText(x, { x: 78, y, size: 8, font });
    page.drawText(yy, { x: 145, y, size: 8, font });
    y -= 17;
  }
  page.drawText("Système de coordonnée : RRS04", { x: 64, y, size: 7, font });

  const pdf = Buffer.from(await doc.save());
  const texte = await extraireTexteParPosition(pdf);
  check("l'extraction par position aboutit", texte !== null);
  if (!texte) return;

  const { bornes } = parseBornes(isolerBlocTableau(texte));
  check(
    "seules les 5 bornes du tableau sont retenues (« 10 000 » écarté)",
    bornes.length === 5 && bornes.every((b, i) => b.x === Number(BORNES[i][1])),
    `${bornes.length} borne(s) : ${JSON.stringify(bornes)}`,
  );

  const rapport = verifier({ bornes, crsSource: "EPSG:32628" });
  check(
    "aucune anomalie HORS_EMPRISE",
    !rapport.anomalies.some((a) => a.code === "HORS_EMPRISE"),
    JSON.stringify(rapport.anomalies.map((a) => a.code)),
  );
}

// --- 11. Import PDF : reconnaissance optique (pdfjs-dist + @napi-rs/canvas + tesseract.js) ---

/**
 * Ne vérifie PAS la justesse de la reconnaissance (dépend de la police, hors
 * de notre contrôle) : vérifie que le pipeline entier — rendu pdfjs sur un
 * canvas @napi-rs/canvas, puis tesseract.js — s'exécute **sans faire planter
 * le process** et renvoie une réponse structurée. C'est le garde-fou contre
 * la régression observée en production : pdfjs-dist@4.10.38 déclare
 * `optionalDependencies: { "@napi-rs/canvas": "^0.1.65" }` ; installer une
 * version différente au niveau racine (ex. la dernière, 1.x) fait coexister
 * deux copies binaires incompatibles de l'addon natif — un objet canvas créé
 * par l'une, passé au rendu interne de l'autre, segfault le process Node
 * (SIGSEGV, incontournable par un try/catch). `@napi-rs/canvas` DOIT rester
 * épinglé sur la plage que pdfjs-dist déclare.
 */
async function testOcr() {
  console.log("\n[11] Import PDF — reconnaissance optique (OCR)");

  const canvas = createCanvas(800, 300);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 800, 300);
  ctx.fillStyle = "#000000";
  ctx.font = "28px sans-serif";
  ["B1 500000.0000 1600100.0000", "B2 500100.0000 1600100.0000"].forEach((l, i) =>
    ctx.fillText(l, 20, 50 + i * 50),
  );
  const png = canvas.toBuffer("image/png");

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  // Texte VECTORIEL (en-tête, cartouche) en plus de l'image du tableau : un
  // plan réel en porte toujours, même quand le tableau lui-même est une
  // image — c'est ce texte qui a déclenché le crash `paintChar` corrigé par
  // `disableFontFace: false` (§ ocr.ts), une image seule ne le reproduit pas.
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText("PLAN DE MORCELLEMENT", { x: 40, y: 780, size: 16, font });
  page.drawText("NICAD 014020030012345", { x: 40, y: 760, size: 10, font });
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 40, y: 500, width: 400, height: 150 });
  const pdf = Buffer.from(await doc.save());

  let res: Awaited<ReturnType<typeof ocrTableauCoordonnees>> | null = null;
  let erreur: unknown = null;
  try {
    res = await ocrTableauCoordonnees(pdf);
  } catch (e) {
    erreur = e;
  }
  check(
    "le pipeline OCR se termine sans lever (pas de segfault de process)",
    erreur === null,
    erreur instanceof Error ? erreur.message : String(erreur),
  );
  check(
    "la réponse a la forme attendue (bornes[], meta, erreurs[])",
    !!res && Array.isArray(res.bornes) && Array.isArray(res.erreurs) && typeof res.meta === "object",
  );
}

// --- 12. Import image directe : reconnaissance optique sans PDF -----------

/**
 * Garde-fou pour la voie image directe (onglet « Photo » de
 * PlanVerifClient.tsx) : pas de rendu pdfjs ici, l'image recadrée par
 * l'opérateur est envoyée telle quelle à tesseract. Comme [11], ne vérifie
 * pas la justesse de la reconnaissance (dépend de la police) mais que le
 * pipeline s'exécute sans lever et renvoie une réponse structurée, sans
 * métadonnées (le recadrage exclut par construction le reste du document).
 */
async function testOcrImage() {
  console.log("\n[12] Import image directe — reconnaissance optique (OCR)");

  const canvas = createCanvas(800, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 800, 200);
  ctx.fillStyle = "#000000";
  ctx.font = "28px sans-serif";
  ["B1 500000.0000 1600100.0000", "B2 500100.0000 1600100.0000"].forEach((l, i) =>
    ctx.fillText(l, 20, 50 + i * 50),
  );
  const png = canvas.toBuffer("image/png");

  let res: Awaited<ReturnType<typeof ocrImageCoordonnees>> | null = null;
  let erreur: unknown = null;
  try {
    res = await ocrImageCoordonnees(png);
  } catch (e) {
    erreur = e;
  }
  check(
    "le pipeline OCR image se termine sans lever",
    erreur === null,
    erreur instanceof Error ? erreur.message : String(erreur),
  );
  check(
    "la réponse a la forme attendue (bornes[], meta={}, erreurs[])",
    !!res &&
      Array.isArray(res.bornes) &&
      Array.isArray(res.erreurs) &&
      typeof res.meta === "object" &&
      !res.meta.nicad &&
      res.meta.superficie === undefined,
  );
}

// --- 13. OCR image avec langPath local (bureau autonome) -----------------

/**
 * Verifie que passer GEOAINO_TESSERACT_LANG_PATH fait toujours fonctionner
 * le pipeline (chemin emprunte par le bureau autonome, cf. ocr.ts). Ne
 * prouve pas l'absence de reseau (hors de portee d'un test unitaire sans
 * mock reseau) — la verification hors-ligne reelle se fait manuellement
 * sur l'app empaquetee (cf. Task 11, checklist de desinstallation/tests).
 */
async function testOcrImageLangPathLocal() {
  console.log("\n[13] Import image directe — langPath local (desktop)");

  const cheminLangue = path.resolve(__dirname, "../desktop/vendor/tesseract-lang");
  if (!existsSync(path.join(cheminLangue, "eng.traineddata.gz"))) {
    console.log("  (desktop/vendor/tesseract-lang absent — executer Task 5, Step 1 ; test ignore)");
    return;
  }

  const ancien = process.env.GEOAINO_TESSERACT_LANG_PATH;
  process.env.GEOAINO_TESSERACT_LANG_PATH = cheminLangue;
  try {
    const canvas = createCanvas(800, 100);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 800, 100);
    ctx.fillStyle = "#000000";
    ctx.font = "28px sans-serif";
    ctx.fillText("B1 500000.0000 1600100.0000", 20, 50);
    const png = canvas.toBuffer("image/png");

    let erreur: unknown = null;
    try {
      await ocrImageCoordonnees(png);
    } catch (e) {
      erreur = e;
    }
    check(
      "le pipeline fonctionne avec un langPath local",
      erreur === null,
      erreur instanceof Error ? erreur.message : String(erreur),
    );
  } finally {
    process.env.GEOAINO_TESSERACT_LANG_PATH = ancien;
  }
}

async function main() {
  await testAllerRetour();
  testParsing();
  testAnomalies();
  testCorrections();
  testTolerance();
  await testPdfTexte();
  await testPdfTableauParPosition();
  await testPdfCartouche();
  await testOcr();
  await testOcrImage();
  await testOcrImageLangPathLocal();

  console.log(`\n${ok} assertion(s) OK, ${ko} en échec.`);
  await prisma.$disconnect();
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
