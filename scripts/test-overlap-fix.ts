/**
 * Test synthétique de la correction des chevauchements (étape 10).
 * Cas 1 : deux carrés 20×20 se chevauchant de 200 m² → l'un est retaillé.
 * Cas 2 : la parcelle NUMÉROTÉE gagne, l'autre est retaillée.
 * Cas 3 : mitoyenneté simple (pas de chevauchement) → aucune retaille.
 */
import { buildParcellesFromFc32628 } from "../src/lib/parcelle-ingestion";
import * as turf from "@turf/turf";

const X = 330000;
const Y = 1610000;

function square(x0: number, y0: number, x1: number, y1: number): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { Layer: "PARCELLES" },
    geometry: {
      type: "Polygon",
      coordinates: [[[X + x0, Y + y0], [X + x1, Y + y0], [X + x1, Y + y1], [X + x0, Y + y1], [X + x0, Y + y0]]],
    },
  };
}

function label(text: string, x: number, y: number): GeoJSON.Feature {
  return {
    type: "Feature",
    properties: { Layer: "numero_parcelle", Text: text },
    geometry: { type: "Point", coordinates: [X + x, Y + y] },
  };
}

function run(name: string, features: GeoJSON.Feature[]) {
  const res = buildParcellesFromFc32628({ type: "FeatureCollection", features });
  const surfaces = res.parcelles.map((p) => Math.round(p.surfaceM2)).sort((a, b) => a - b);
  // Vérifie qu'aucune paire résiduelle ne se chevauche (en 4326 via turf).
  let residual = 0;
  for (let i = 0; i < res.parcelles.length; i++) {
    for (let j = i + 1; j < res.parcelles.length; j++) {
      const inter = turf.intersect(
        turf.featureCollection([
          turf.feature(res.parcelles[i].geomGeoJson4326),
          turf.feature(res.parcelles[j].geomGeoJson4326),
        ])
      );
      if (inter && turf.area(inter) > 0.5) residual++;
    }
  }
  console.log(name, {
    nbParcelles: res.parcelles.length,
    surfaces,
    nbChevauchements: res.report.nbChevauchements,
    corriges: res.report.nbChevauchementsCorriges,
    videes: res.report.nbParcellesVideesParChevauchement,
    chevauchementsResiduels: residual,
    numeros: res.parcelles.map((p) => p.numero),
  });
  return { res, residual, surfaces };
}

// Cas 1 : A=(0,0)-(20,20) [400 m²], B=(10,0)-(30,20) [400 m²], chevauchement 200 m².
const c1 = run("cas1 chevauchement simple", [square(0, 0, 20, 20), square(10, 0, 30, 20)]);
console.assert(c1.res.parcelles.length === 2, "cas1: 2 parcelles attendues");
console.assert(c1.res.report.nbChevauchements === 1, "cas1: 1 chevauchement détecté");
console.assert(c1.res.report.nbChevauchementsCorriges === 1, "cas1: 1 parcelle retaillée");
console.assert(c1.residual === 0, "cas1: plus aucun chevauchement résiduel");
console.assert(
  Math.abs(c1.surfaces[0] - 200) < 2 && Math.abs(c1.surfaces[1] - 400) < 2,
  "cas1: surfaces 200 + 400 attendues"
);

// Cas 2 : B porte un numéro → B (numérotée) gagne, A est retaillée à ~200 m².
const c2 = run("cas2 priorité au numéro", [
  square(0, 0, 20, 20),
  square(10, 0, 30, 20),
  label("12345", 25, 10), // dans B uniquement
]);
const numbered2 = c2.res.parcelles.find((p) => p.numero === "12345");
console.assert(numbered2 != null, "cas2: la parcelle numérotée existe");
console.assert(
  numbered2 != null && Math.abs(numbered2.surfaceM2 - 400) < 2,
  `cas2: la parcelle numérotée garde ses 400 m² (obtenu: ${numbered2?.surfaceM2})`
);
console.assert(c2.residual === 0, "cas2: plus aucun chevauchement résiduel");

// Cas 3 : mitoyenneté stricte (limite partagée, aucun recouvrement) → rien à corriger.
const c3 = run("cas3 mitoyenneté", [square(0, 0, 20, 20), square(20, 0, 40, 20)]);
console.assert(c3.res.report.nbChevauchements === 0, "cas3: aucun chevauchement détecté");
console.assert(c3.res.report.nbChevauchementsCorriges === 0, "cas3: aucune retaille");
console.assert(c3.res.parcelles.length === 2, "cas3: 2 parcelles conservées");

// Cas 4 : absorption totale — sliver non numéroté 90+% dedans est géré par la
// CONTENANCE du dédoublonnage ; ici un polygone 60% recouvert par DEUX voisins
// numérotés est retaillé deux fois.
const c4 = run("cas4 double retaille", [
  square(0, 0, 20, 20),
  square(30, 0, 50, 20),
  square(10, 0, 40, 20), // recouvre 10 m de A et 10 m de B
  label("00001", 5, 10),
  label("00002", 45, 10),
]);
console.assert(c4.residual === 0, "cas4: plus aucun chevauchement résiduel");
const middle = c4.res.parcelles.find((p) => !p.numero);
console.assert(
  middle != null && Math.abs(middle.surfaceM2 - 200) < 2,
  `cas4: la parcelle centrale retaillée à 200 m² (obtenu: ${middle?.surfaceM2})`
);

console.log("Tous les asserts passés (aucune sortie console.assert = OK).");
