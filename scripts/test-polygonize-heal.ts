/**
 * Test synthétique du raccord des micro-trous (`healUndershoots`) :
 * Cas 1 : limite mitoyenne en undershoot (s'arrête à 12 cm du contour) →
 *         sans raccord, les deux parcelles fusionnent en une face de 800 m² ;
 *         avec raccord, on retrouve bien 2 parcelles de ~400 m².
 * Cas 2 : coin ouvert (deux limites s'arrêtent à 10 cm l'une de l'autre) →
 *         sans raccord, l'anneau ne se referme pas (0 polygone) ;
 *         avec raccord, le carré est reconstruit.
 * Cas 3 : trou volontairement > tolérance → PAS raccordé (pas de sur-correction).
 * Cas 4 : mitoyenneté saine (limite qui touche exactement) → résultat inchangé.
 */
import { polygonizeLines } from "../src/lib/polygonize";

const X = 330000;
const Y = 1610000;

type Line = number[][];
const seg = (x0: number, y0: number, x1: number, y1: number): Line => [
  [X + x0, Y + y0],
  [X + x1, Y + y1],
];

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("ÉCHEC:", msg);
  }
}

function areas(polys: GeoJSON.Polygon[]): number[] {
  // Aire planaire (coordonnées déjà en mètres) via la formule du lacet.
  return polys
    .map((p) => {
      const ring = p.coordinates[0];
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      return Math.abs(a / 2);
    })
    .sort((a, b) => a - b);
}

// ---- Cas 1 : undershoot de la limite mitoyenne (cause des parcelles fusionnées).
// Enveloppe 40×20 (4 segments exacts) + limite mitoyenne x=20 qui s'arrête à
// 12 cm du bord haut et du bord bas.
const cas1: Line[] = [
  seg(0, 0, 40, 0),
  seg(40, 0, 40, 20),
  seg(40, 20, 0, 20),
  seg(0, 20, 0, 0),
  seg(20, 0.12, 20, 19.88),
];

const merged = polygonizeLines(cas1, { minAreaM2: 1, snapToleranceM: 0 });
check(merged.length === 1, `cas1 sans raccord : 1 face fusionnée attendue (obtenu ${merged.length})`);
check(
  merged.length === 1 && Math.abs(areas(merged)[0] - 800) < 2,
  `cas1 sans raccord : ~800 m² attendus (obtenu ${areas(merged)[0]?.toFixed(1)})`
);

const healed = polygonizeLines(cas1, { minAreaM2: 1, snapToleranceM: 0.25 });
const a1 = areas(healed);
check(healed.length === 2, `cas1 avec raccord : 2 parcelles attendues (obtenu ${healed.length})`);
check(
  healed.length === 2 && Math.abs(a1[0] - 400) < 5 && Math.abs(a1[1] - 400) < 5,
  `cas1 avec raccord : ~400 + 400 m² attendus (obtenu ${a1.map((a) => a.toFixed(1)).join(", ")})`
);

// ---- Cas 2 : coin ouvert (10 cm entre deux extrémités).
const cas2: Line[] = [
  seg(0, 0, 20, 0),
  seg(20, 0, 20, 20),
  seg(20, 20, 0, 20),
  seg(0, 20, 0, 0.1), // s'arrête à 10 cm du coin (0,0)
];
const openCorner = polygonizeLines(cas2, { minAreaM2: 1, snapToleranceM: 0 });
check(openCorner.length === 0, `cas2 sans raccord : anneau non fermé, 0 polygone attendu (obtenu ${openCorner.length})`);
const closedCorner = polygonizeLines(cas2, { minAreaM2: 1, snapToleranceM: 0.25 });
check(closedCorner.length === 1, `cas2 avec raccord : 1 polygone attendu (obtenu ${closedCorner.length})`);
check(
  closedCorner.length === 1 && Math.abs(areas(closedCorner)[0] - 400) < 5,
  `cas2 avec raccord : ~400 m² attendus (obtenu ${areas(closedCorner)[0]?.toFixed(1)})`
);

// ---- Cas 3 : trou de 60 cm > tolérance (25 cm) → on ne raccorde PAS.
const cas3: Line[] = [
  seg(0, 0, 40, 0),
  seg(40, 0, 40, 20),
  seg(40, 20, 0, 20),
  seg(0, 20, 0, 0),
  seg(20, 0.6, 20, 19.4),
];
const untouched = polygonizeLines(cas3, { minAreaM2: 1, snapToleranceM: 0.25 });
check(
  untouched.length === 1,
  `cas3 : trou > tolérance, la face reste fusionnée (obtenu ${untouched.length} polygone(s))`
);
check(
  untouched.length === 1 && Math.abs(areas(untouched)[0] - 800) < 2,
  `cas3 : géométrie intacte, ~800 m² (obtenu ${areas(untouched)[0]?.toFixed(1)})`
);

// ---- Cas 4 : mitoyenneté saine (limite exacte) → toujours 2 parcelles, géométrie stable.
const cas4: Line[] = [
  seg(0, 0, 40, 0),
  seg(40, 0, 40, 20),
  seg(40, 20, 0, 20),
  seg(0, 20, 0, 0),
  seg(20, 0, 20, 20),
];
const sain = polygonizeLines(cas4, { minAreaM2: 1, snapToleranceM: 0.25 });
const a4 = areas(sain);
check(sain.length === 2, `cas4 : 2 parcelles attendues (obtenu ${sain.length})`);
check(
  sain.length === 2 && Math.abs(a4[0] - 400) < 0.01 && Math.abs(a4[1] - 400) < 0.01,
  `cas4 : géométrie saine inchangée, 400 + 400 m² (obtenu ${a4.map((a) => a.toFixed(2)).join(", ")})`
);

// ---- Cas 5 : échelle SECTION (limite mitoyenne avec trou de 80 cm).
// À la tolérance parcelles (0,25 m) les deux sections restent fusionnées ; à la
// tolérance sections (1 m, cf. DXF_SECTION_SNAP_TOLERANCE_M) elles se séparent.
const cas5: Line[] = [
  seg(0, 0, 2000, 0),
  seg(2000, 0, 2000, 1000),
  seg(2000, 1000, 0, 1000),
  seg(0, 1000, 0, 0),
  seg(1000, 0.8, 1000, 999.2),
];
const secMerged = polygonizeLines(cas5, { minAreaM2: 1, snapToleranceM: 0.25 });
check(secMerged.length === 1, `cas5 tol 0.25 : sections fusionnées attendues (obtenu ${secMerged.length})`);
const secHealed = polygonizeLines(cas5, { minAreaM2: 1, snapToleranceM: 1 });
const a5 = areas(secHealed);
check(secHealed.length === 2, `cas5 tol 1 m : 2 sections attendues (obtenu ${secHealed.length})`);
check(
  secHealed.length === 2 && Math.abs(a5[0] - 1_000_000) < 3000 && Math.abs(a5[1] - 1_000_000) < 3000,
  `cas5 tol 1 m : ~2 × 1 km² attendus (obtenu ${a5.map((a) => (a / 1e6).toFixed(3)).join(", ")} km²)`
);

// ---- Cas 6 : lignes DUPLIQUÉES (copies Microstation) + trou en T de 5 cm.
// Le jumeau d'une ligne masquait le raccord (« déjà connectée » à distance 0) :
// la mitoyenne restait pendante et les deux faces fusionnaient (cas réel
// sections 017/020, commune DYA, fichier Kaolack). Le dédoublonnage préalable
// des lignes rétablit le raccord.
const cas6Base: Line[] = [
  seg(0, 0, 40, 0),
  seg(40, 0, 40, 20),
  seg(40, 20, 0, 20),
  seg(0, 20, 0, 0),
  seg(20, 0.05, 20, 20), // mitoyenne : T-jonction à 5 cm du bord bas, exacte en haut
];
const cas6: Line[] = [...cas6Base, ...cas6Base.map((l) => l.map((c) => [...c]))];
const dedupHealed = polygonizeLines(cas6, { minAreaM2: 1, snapToleranceM: 0.25 });
const a6 = areas(dedupHealed);
check(dedupHealed.length === 2, `cas6 : 2 parcelles attendues malgré les doublons (obtenu ${dedupHealed.length})`);
check(
  dedupHealed.length === 2 && Math.abs(a6[0] - 400) < 3 && Math.abs(a6[1] - 400) < 3,
  `cas6 : ~400 + 400 m² attendus (obtenu ${a6.map((a) => a.toFixed(1)).join(", ")})`
);

if (failures > 0) {
  console.error(`${failures} vérification(s) en échec.`);
  process.exit(1);
}
console.log("test-polygonize-heal : tous les cas passent.");
