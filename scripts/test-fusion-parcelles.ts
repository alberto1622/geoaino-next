/**
 * Test du cas « deux parcelles côte à côte fusionnées sous un seul numéro »
 * (ex. terrain : 00017 + 00020 → une seule parcelle 00017).
 *
 * Cas 1 : contour d'îlot sur `limites_parcelles`, limite mitoyenne sur
 *         `limites_tf` (calque différent). Avant le réseau unifié, chaque classe
 *         était polygonisée séparément → la mitoyenne manquait au réseau →
 *         une seule face portant les deux numéros.
 * Cas 2 : mitoyenne réellement absente → la fusion est inévitable, mais le
 *         rapport doit la SIGNALER (nbParcellesMultiNumeros).
 */
import { buildParcellesFromFc32628 } from "../src/lib/parcelle-ingestion";

const X = 330000;
const Y = 1610000;

function line(layer: string, coords: number[][]): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { Layer: layer },
    geometry: { type: "LineString", coordinates: coords.map(([x, y]) => [X + x, Y + y]) },
  };
}

function label(text: string, x: number, y: number): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { Layer: "numero_parcelle", Text: text },
    geometry: { type: "Point", coordinates: [X + x, Y + y] },
  };
}

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("ÉCHEC:", msg);
  }
}

// Îlot 40×20 dessiné en 4 segments ouverts sur limites_parcelles.
const outline = [
  line("limites_parcelles", [[0, 0], [40, 0]]),
  line("limites_parcelles", [[40, 0], [40, 20]]),
  line("limites_parcelles", [[40, 20], [0, 20]]),
  line("limites_parcelles", [[0, 20], [0, 0]]),
];
const labels = [label("00017", 10, 10), label("00020", 30, 10)];

// ── Cas 1 : mitoyenne sur limites_tf (calque différent du contour) ──────────
const r1 = buildParcellesFromFc32628({
  type: "FeatureCollection",
  features: [...outline, line("limites_tf", [[20, 0], [20, 20]]), ...labels],
});
const numeros1 = r1.parcelles.map((p) => p.numero).sort();
check(r1.parcelles.length === 2, `cas1 : 2 parcelles attendues (obtenu ${r1.parcelles.length})`);
check(
  numeros1.join(",") === "00017,00020",
  `cas1 : numéros 00017 + 00020 attendus (obtenu ${numeros1.join(",")})`
);
check(
  r1.report.nbParcellesMultiNumeros === 0,
  `cas1 : aucune parcelle multi-numéros attendue (obtenu ${r1.report.nbParcellesMultiNumeros})`
);

// ── Cas 2 : mitoyenne absente → fusion inévitable mais SIGNALÉE ─────────────
const r2 = buildParcellesFromFc32628({
  type: "FeatureCollection",
  features: [...outline, ...labels],
});
check(r2.parcelles.length === 1, `cas2 : 1 parcelle fusionnée attendue (obtenu ${r2.parcelles.length})`);
check(
  r2.report.nbParcellesMultiNumeros === 1,
  `cas2 : 1 parcelle multi-numéros signalée attendue (obtenu ${r2.report.nbParcellesMultiNumeros})`
);
check(
  r2.report.warnings.some((w) => w.includes("PLUSIEURS numéros")),
  "cas2 : warning « PLUSIEURS numéros » attendu dans le rapport"
);

// ── Cas 3 : mitoyenne sur limites_sections (limite de section = limite de parcelle) ──
const r3 = buildParcellesFromFc32628({
  type: "FeatureCollection",
  features: [...outline, line("limites_sections", [[20, 0], [20, 20]]), ...labels],
});
const numeros3 = r3.parcelles.map((p) => p.numero).sort();
check(r3.parcelles.length === 2, `cas3 : 2 parcelles attendues (obtenu ${r3.parcelles.length})`);
check(
  numeros3.join(",") === "00017,00020",
  `cas3 : numéros 00017 + 00020 attendus (obtenu ${numeros3.join(",")})`
);

// ── Cas 4 : composante SECTION du NICAD — l'anneau d'ensemble (sans numéro)
// ne doit pas rafler la jointure parcelle ∈ section : c'est la plus petite
// section NUMÉROTÉE contenante qui alimente numero_section.
function closedRing(layer: string, coords: number[][]): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { Layer: layer },
    geometry: {
      type: "Polygon",
      coordinates: [[...coords, coords[0]].map(([x, y]) => [X + x, Y + y])],
    },
  };
}
function sectionLabel(text: string, x: number, y: number): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { Layer: "numero_section", Text: text },
    geometry: { type: "Point", coordinates: [X + x, Y + y] },
  };
}
const r4 = buildParcellesFromFc32628({
  type: "FeatureCollection",
  features: [
    // Enveloppe englobant les deux sections — volontairement SANS numéro.
    closedRing("limite_section", [[-10, -10], [110, -10], [110, 70], [-10, 70]]),
    // Deux vraies sections numérotées.
    closedRing("limite_section", [[0, 0], [50, 0], [50, 60], [0, 60]]),
    closedRing("limite_section", [[50, 0], [100, 0], [100, 60], [50, 60]]),
    sectionLabel("7", 25, 45),
    sectionLabel("8", 75, 45),
    // Une parcelle dans la section 007.
    closedRing("limites_parcelles", [[10, 10], [30, 10], [30, 30], [10, 30]]),
    label("00001", 20, 20),
  ],
});
const p4 = r4.parcelles.find((p) => p.numero === "00001");
check(p4 != null, "cas4 : la parcelle 00001 existe");
check(
  p4?.numeroSection === "007",
  `cas4 : numero_section=007 attendu pour le NICAD (obtenu ${p4?.numeroSection ?? "null"})`
);

if (failures > 0) {
  console.error(`${failures} vérification(s) en échec.`);
  process.exit(1);
}
console.log("test-fusion-parcelles : tous les cas passent.");
