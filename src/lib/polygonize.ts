/**
 * polygonize.ts
 *
 * Reconstruction de polygones fermés à partir d'un réseau de lignes
 * (segments de limites de parcelle dessinés séparément, fréquents dans les
 * DXF issus d'une conversion DGN/Microstation). S'appuie sur JSTS :
 *   1. noding du réseau (UnaryUnionOp casse les lignes à leurs intersections),
 *   2. polygonisation (Polygonizer assemble les anneaux fermés minimaux).
 *
 * Les coordonnées sont planes (EPSG:32628, mètres) : l'aire JSTS est donc
 * directement en m², ce qui permet de filtrer les artefacts.
 */

import * as jsts from "jsts";

type LineCoords = number[][]; // [[x,y], ...]

function ringFromJsts(coords: Array<{ x: number; y: number }>): number[][] {
  return coords.map((c) => [c.x, c.y]);
}

function jstsPolygonToCoordinates(poly: {
  getExteriorRing: () => { getCoordinates: () => Array<{ x: number; y: number }> };
  getNumInteriorRing: () => number;
  getInteriorRingN: (i: number) => { getCoordinates: () => Array<{ x: number; y: number }> };
}): number[][][] {
  const rings: number[][][] = [ringFromJsts(poly.getExteriorRing().getCoordinates())];
  const holes = poly.getNumInteriorRing();
  for (let i = 0; i < holes; i++) {
    rings.push(ringFromJsts(poly.getInteriorRingN(i).getCoordinates()));
  }
  return rings;
}

export interface PolygonizeOptions {
  /** Aire minimale (m²) d'un polygone conservé. Élimine les slivers. */
  minAreaM2?: number;
  /** Aire maximale (m²) conservée. Élimine l'anneau enveloppe global. */
  maxAreaM2?: number;
  /**
   * Au-delà de ce nombre de lignes, la polygonisation est partitionnée en
   * tuiles spatiales (cf. `polygonizeTiled`) : un `UnaryUnion` global sur des
   * centaines de milliers de segments (DXF issu d'un DGN cadastral) ne revient
   * jamais. En-dessous, on garde le chemin direct (union globale, déterministe).
   */
  tileThreshold?: number;
  /**
   * Nombre de segments visé par tuile. Borne le coût du noding/polygonisation
   * de chaque tuile.
   */
  tileTargetSegments?: number;
  /**
   * Marge (m) ajoutée autour de chaque tuile pour la collecte des segments :
   * doit dépasser le diamètre d'une parcelle pour garantir qu'une parcelle dont
   * le centroïde tombe dans la tuile a TOUS ses segments présents dans la
   * fenêtre élargie (sinon elle ne se referme pas). ~400 m > côté d'une parcelle
   * de 50 000 m² (≈224 m).
   */
  tileMarginM?: number;
  /**
   * Tolérance (m) de raccord des extrémités pendantes AVANT noding : une limite
   * mitoyenne qui s'arrête à quelques cm du contour (« undershoot » de
   * numérisation) est un *dangle* que le Polygonizer ignore → les deux parcelles
   * voisines sortent FUSIONNÉES en une seule face. Le raccord referme ces
   * micro-trous. 0 = désactivé.
   */
  snapToleranceM?: number;
}

const TILE_THRESHOLD = Number(process.env.DXF_POLYGONIZE_TILE_THRESHOLD || 20000);
const TILE_TARGET_SEGMENTS = Number(process.env.DXF_POLYGONIZE_TILE_TARGET || 4000);
const TILE_MARGIN_M = Number(process.env.DXF_POLYGONIZE_TILE_MARGIN_M || 400);
// Une tuile de la grille uniforme peut, sur un fichier départemental où les
// parcelles sont concentrées (cœur urbain dense noyé dans des communes rurales
// éparses), absorber >100 000 segments : la grille est calibrée sur la densité
// MOYENNE, pas locale. Un tel bloc fait échouer le noding (« non-noded
// intersection ») même après snap-rounding → tuile perdue → tout le centre-ville
// disparaît. On subdivise donc récursivement toute tuile dépassant ce seuil (ou
// qui échoue au noding) jusqu'à des sous-tuiles nodables. `MAX_DEPTH` borne la
// récursion ; `MIN_TILE_M` empêche de subdiviser sous la taille d'une parcelle.
const TILE_MAX_SEGMENTS = Number(process.env.DXF_POLYGONIZE_TILE_MAX_SEGMENTS || 8000);
const TILE_MAX_DEPTH = Number(process.env.DXF_POLYGONIZE_TILE_MAX_DEPTH || 8);
const TILE_MIN_SIZE_M = Number(process.env.DXF_POLYGONIZE_TILE_MIN_SIZE_M || 500);
// Tolérance de raccord des extrémités pendantes (cf. `healUndershoots`). Une
// vraie limite de parcelle s'arrête rarement à > 25 cm de sa voisine, et deux
// sommets cadastraux distincts sont à plusieurs mètres l'un de l'autre : 25 cm
// referme les trous de numérisation sans fusionner de sommets légitimes.
const SNAP_TOLERANCE_M = Number(process.env.DXF_POLYGONIZE_SNAP_TOLERANCE_M ?? 0.25);

type LineBBox = [number, number, number, number]; // [minX, minY, maxX, maxY]

function lineBBox(line: LineCoords): LineBBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of line) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Node puis polygonise un sous-ensemble de lignes en une seule passe (union
 * globale). Conserve les polygones dont l'aire ∈ [minArea, maxArea] et,
 * optionnellement, dont le centroïde satisfait `ownsPolygon` (attribution à
 * une tuile unique pour éviter les doublons en bordure de tuile).
 */
// Échelles de snap-rounding (unités = 1/scale mètre) essayées successivement
// pour le noding. Les réseaux cadastraux issus d'un DGN portent des
// micro-intersections (deux limites se croisant à ~0,01 mm près, présentes dans
// une ligne mais pas l'autre) qui font échouer le noding « rapide » d'UnaryUnion
// (« found non-noded intersection »). En accrochant explicitement les
// coordonnées à une grille de plus en plus grossière (1 mm → 1 cm → 5 cm →
// 10 cm → 20 cm) via GeometryPrecisionReducer, le réseau devient noded de façon
// cohérente. Les deux dernières échelles (10/5) ne sont atteintes qu'en dernier
// recours (les erreurs topologiques franches, sommet manquant sur la ligne
// croisée, résistent au snap fin) : un snap à 20 cm peut fusionner deux sommets
// distincts proches, acceptable seulement quand tout le reste a échoué. Un simple
// PrecisionModel sur la GeometryFactory ne suffit PAS : `createLineString`
// n'arrondit pas les coordonnées, seul le réducteur le fait.
const PRECISION_SCALES = (process.env.DXF_POLYGONIZE_PRECISION_SCALES || "1000,100,20,10,5")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * Union/noding robuste d'un MultiLineString : tente le noding après snap-rounding
 * à des grilles de plus en plus grossières jusqu'à réussite. Relève la dernière
 * erreur si toutes les échelles échouent (traité en amont par tuile).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function robustNodedUnion(mls: any): any {
  let lastErr: unknown;
  for (const scale of PRECISION_SCALES) {
    try {
      const reducer = new jsts.precision.GeometryPrecisionReducer(
        new jsts.geom.PrecisionModel(scale)
      );
      const reduced = reducer.reduce(mls);
      return jsts.operation.union.UnaryUnionOp.union(reduced);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Compteurs de raccord (diagnostic ; en tuilé, une extrémité en marge peut être comptée dans plusieurs tuiles). */
interface HealStats {
  /** Extrémités regroupées sur une extrémité voisine (trou coin-à-coin). */
  endpointsClustered: number;
  /** Extrémités raccrochées à un segment/sommet voisin (undershoot en T). */
  endpointsSnapped: number;
}

/**
 * Referme les micro-trous du réseau de limites AVANT noding. Deux défauts de
 * numérisation distincts font fusionner des parcelles voisines :
 *
 *  - « undershoot » : la limite mitoyenne s'arrête à quelques cm du contour →
 *    ligne pendante (*dangle*), ignorée par le Polygonizer → une seule face
 *    couvrant les deux parcelles ;
 *  - trou coin-à-coin : deux limites censées se rejoindre en un coin s'arrêtent
 *    à quelques cm l'une de l'autre → l'anneau ne se referme pas du tout.
 *
 * Deux passes :
 *  1. regroupement des extrémités à ≤ tol l'une de l'autre sur une position
 *     canonique (la première vue — les représentants ne bougent jamais, donc
 *     pas d'effet de cascade) ;
 *  2. pour chaque extrémité encore pendante, raccord au segment le plus proche
 *     (≤ tol) : l'extrémité est déplacée sur sa projection ET ce point est
 *     INSÉRÉ comme sommet du segment cible — le partage de coordonnée exact
 *     garantit le noding, là où un point « presque sur » la ligne (~1e-13 m)
 *     peut échapper au test d'intersection robuste.
 *
 * Ne mute jamais les tableaux d'entrée (partagés entre tuiles via les fenêtres
 * à marge) : copie à l'écriture.
 */
function healUndershoots(lines: LineCoords[], tol: number, stats?: HealStats): LineCoords[] {
  if (!(tol > 0) || lines.length === 0) return lines;
  const tolSq = tol * tol;
  // Seule une coordonnée EXACTEMENT partagée avec un sommet garantit le noding.
  // Un seuil de « contact » par distance (même 1 µm) est un faux ami : un point
  // à 0,7 µm d'un segment n'est PAS une intersection pour le noding robuste
  // (cas réel : mitoyenne des sections 017/020 de DYA, restée pendante). On ne
  // court-circuite donc que sur l'égalité exacte de sommet ; toute distance > 0
  // à un segment est raccordée par insertion (coordonnée partagée garantie).
  const vertexExactSq = 1e-20;

  const out: LineCoords[] = lines.slice();
  const owned = new Array<boolean>(lines.length).fill(false);
  const own = (i: number): LineCoords => {
    if (!owned[i]) {
      out[i] = out[i].map((c) => [c[0], c[1]]);
      owned[i] = true;
    }
    return out[i];
  };

  // Extrémités libres : premières/dernières coordonnées des polylignes ouvertes.
  const endpoints: Array<[number, number]> = []; // [indice ligne, indice sommet]
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    if (l.length < 2) continue;
    const f = l[0];
    const e = l[l.length - 1];
    if (f[0] === e[0] && f[1] === e[1]) continue; // anneau fermé : rien à raccorder
    endpoints.push([i, 0], [i, l.length - 1]);
  }
  if (endpoints.length === 0) return out;

  const keyOf = (cx: number, cy: number) => cx + ":" + cy;

  // ---- Passe 1 : regroupement des extrémités proches (trous coin-à-coin). ----
  const repGrid = new Map<string, Array<[number, number]>>();
  for (const [li, vi] of endpoints) {
    const p = out[li][vi];
    const cx = Math.floor(p[0] / tol);
    const cy = Math.floor(p[1] / tol);
    let rep: [number, number] | null = null;
    for (let dx = -1; dx <= 1 && !rep; dx++) {
      for (let dy = -1; dy <= 1 && !rep; dy++) {
        const reps = repGrid.get(keyOf(cx + dx, cy + dy));
        if (!reps) continue;
        for (const r of reps) {
          const ddx = r[0] - p[0];
          const ddy = r[1] - p[1];
          if (ddx * ddx + ddy * ddy <= tolSq) {
            rep = r;
            break;
          }
        }
      }
    }
    if (rep) {
      if (rep[0] !== p[0] || rep[1] !== p[1]) {
        own(li)[vi] = [rep[0], rep[1]];
        if (stats) stats.endpointsClustered++;
      }
    } else {
      const k = keyOf(cx, cy);
      const arr = repGrid.get(k);
      const self: [number, number] = [p[0], p[1]];
      if (arr) arr.push(self);
      else repGrid.set(k, [self]);
    }
  }

  // ---- Passe 2 : extrémités pendantes → raccord au segment le plus proche. ----
  // Index spatial des segments (bbox → cellules de grille). La taille de
  // cellule est bornée par l'étendue du PLUS GRAND segment : chaque segment
  // est inséré dans toutes les cellules du rectangle de sa bbox, donc un
  // segment kilométrique sur des cellules de 8 m insérerait des MILLIONS de
  // cellules (« RangeError: Map maximum size exceeded » — limites de sections
  // Matam). Avec la borne, ≤ ~65 cellules par axe et par segment ; des
  // cellules plus grandes ajoutent des candidats par requête, mais le calcul
  // de distance exact filtre — seul le coût varie, jamais le résultat.
  let maxSpan = 0;
  for (const l of out) {
    for (let s = 0; s < l.length - 1; s++) {
      const w = Math.abs(l[s + 1][0] - l[s][0]);
      const h = Math.abs(l[s + 1][1] - l[s][1]);
      if (w > maxSpan) maxSpan = w;
      if (h > maxSpan) maxSpan = h;
    }
  }
  const segCell = Math.max(tol * 4, 8, maxSpan / 64);
  const segs: Array<[number, number]> = []; // [indice ligne, indice du 1er sommet]
  const segGrid = new Map<string, number[]>();
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    for (let s = 0; s < l.length - 1; s++) {
      const idx = segs.length;
      segs.push([i, s]);
      const x0 = Math.min(l[s][0], l[s + 1][0]);
      const x1 = Math.max(l[s][0], l[s + 1][0]);
      const y0 = Math.min(l[s][1], l[s + 1][1]);
      const y1 = Math.max(l[s][1], l[s + 1][1]);
      for (let cx = Math.floor(x0 / segCell); cx <= Math.floor(x1 / segCell); cx++) {
        for (let cy = Math.floor(y0 / segCell); cy <= Math.floor(y1 / segCell); cy++) {
          const k = keyOf(cx, cy);
          const arr = segGrid.get(k);
          if (arr) arr.push(idx);
          else segGrid.set(k, [idx]);
        }
      }
    }
  }

  // Points à insérer dans les segments cibles, appliqués en bloc à la fin (les
  // indices de sommets restent stables pendant la boucle de décision).
  const insertions = new Map<number, Array<{ s: number; t: number; x: number; y: number }>>();

  for (const [li, vi] of endpoints) {
    const p = out[li][vi];
    const px = p[0];
    const py = p[1];
    // Segment incident à cette extrémité (contient p à distance 0 : à ignorer).
    const incident = vi === 0 ? 0 : out[li].length - 2;

    let touching = false;
    let bestSegIdx = -1;
    let bestSegD2 = tolSq;
    let bestT = 0;
    let bestX = 0;
    let bestY = 0;
    // Infinity (et non tolSq) : sinon, sans aucun candidat, vertD == tol
    // validerait `vertD <= tol` et raccorderait vers les coordonnées par défaut.
    let bestVertD2 = Infinity;
    let bestVX = 0;
    let bestVY = 0;

    const cx0 = Math.floor((px - tol) / segCell);
    const cx1 = Math.floor((px + tol) / segCell);
    const cy0 = Math.floor((py - tol) / segCell);
    const cy1 = Math.floor((py + tol) / segCell);
    const seen = new Set<number>();
    for (let cx = cx0; cx <= cx1 && !touching; cx++) {
      for (let cy = cy0; cy <= cy1 && !touching; cy++) {
        const arr = segGrid.get(keyOf(cx, cy));
        if (!arr) continue;
        for (const idx of arr) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const [sl, ss] = segs[idx];
          if (sl === li && ss === incident) continue;
          const line = out[sl];
          const ax = line[ss][0];
          const ay = line[ss][1];
          const bx = line[ss + 1][0];
          const by = line[ss + 1][1];
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = ax + t * dx;
          const qy = ay + t * dy;
          const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
          const dva = (px - ax) * (px - ax) + (py - ay) * (py - ay);
          const dvb = (px - bx) * (px - bx) + (py - by) * (py - by);
          // Sommet exactement partagé (jonction en coin déjà nodale) : rien à faire.
          if (dva <= vertexExactSq || dvb <= vertexExactSq) {
            touching = true;
            break;
          }
          if (dva < bestVertD2) {
            bestVertD2 = dva;
            bestVX = ax;
            bestVY = ay;
          }
          if (dvb < bestVertD2) {
            bestVertD2 = dvb;
            bestVX = bx;
            bestVY = by;
          }
          if (d2 < bestSegD2) {
            bestSegD2 = d2;
            bestSegIdx = idx;
            bestT = t;
            bestX = qx;
            bestY = qy;
          }
        }
      }
    }
    if (touching) continue;

    const segD = bestSegIdx >= 0 ? Math.sqrt(bestSegD2) : Infinity;
    const vertD = Math.sqrt(bestVertD2);
    // Sommet existant presque aussi proche que la projection : raccord « propre »
    // (coordonnée déjà partagée, pas d'insertion). La distorsion reste ≤ tol.
    if (vertD <= tol && vertD <= segD + tol * 0.5) {
      own(li)[vi] = [bestVX, bestVY];
      if (stats) stats.endpointsSnapped++;
    } else if (bestSegIdx >= 0) {
      own(li)[vi] = [bestX, bestY];
      const [sl, ss] = segs[bestSegIdx];
      let arr = insertions.get(sl);
      if (!arr) {
        arr = [];
        insertions.set(sl, arr);
      }
      arr.push({ s: ss, t: bestT, x: bestX, y: bestY });
      if (stats) stats.endpointsSnapped++;
    }
  }

  // Application des insertions : reconstruit chaque ligne cible avec les points
  // projetés intercalés dans l'ordre (indice de segment, abscisse curviligne).
  for (const [li, ins] of insertions) {
    const line = own(li);
    ins.sort((a, b) => a.s - b.s || a.t - b.t);
    const rebuilt: number[][] = [];
    let k = 0;
    for (let v = 0; v < line.length; v++) {
      rebuilt.push(line[v]);
      while (k < ins.length && ins[k].s === v) {
        const prev = rebuilt[rebuilt.length - 1];
        if (prev[0] !== ins[k].x || prev[1] !== ins[k].y) {
          rebuilt.push([ins[k].x, ins[k].y]);
        }
        k++;
      }
    }
    out[li] = rebuilt;
  }

  return out;
}

function polygonizeChunk(
  lines: LineCoords[],
  minArea: number,
  maxArea: number,
  ownsPolygon?: (cx: number, cy: number) => boolean,
  snapTol = 0,
  stats?: HealStats
): GeoJSON.Polygon[] {
  // Raccord des micro-trous (undershoots/coins ouverts) avant noding : sans lui,
  // les limites mitoyennes pendantes font fusionner les parcelles voisines.
  const healed = healUndershoots(lines, snapTol, stats);

  const gf = new jsts.geom.GeometryFactory();
  const jstsLines = healed
    .filter((l) => Array.isArray(l) && l.length >= 2)
    .map((l) =>
      gf.createLineString(l.map(([x, y]: number[]) => new jsts.geom.Coordinate(x, y)))
    );

  if (jstsLines.length === 0) return [];

  const mls = gf.createMultiLineString(jstsLines);
  // Noding robuste (snap-rounding progressif), pré-requis du Polygonizer.
  const noded = robustNodedUnion(mls);

  const polygonizer = new jsts.operation.polygonize.Polygonizer();
  polygonizer.add(noded);

  const result: GeoJSON.Polygon[] = [];
  const polys = polygonizer.getPolygons().toArray();
  for (const poly of polys) {
    const area = poly.getArea();
    if (area < minArea || area > maxArea) continue;
    if (ownsPolygon) {
      const c = poly.getCentroid().getCoordinate();
      if (!ownsPolygon(c.x, c.y)) continue;
    }
    result.push({ type: "Polygon", coordinates: jstsPolygonToCoordinates(poly) });
  }
  return result;
}

/**
 * Polygonisation partitionnée en tuiles spatiales pour les très gros réseaux de
 * segments. Chaque tuile collecte les segments dont la bbox intersecte la tuile
 * élargie d'une marge `tileMarginM` (donc tous les segments de toute parcelle
 * dont le centroïde tombe dans la tuile « cœur »), polygonise localement, puis
 * ne conserve que les polygones dont le centroïde appartient à la tuile cœur.
 * Chaque parcelle est ainsi reconstruite et comptée exactement une fois.
 */
function polygonizeTiled(
  lines: LineCoords[],
  minArea: number,
  maxArea: number,
  targetSegments: number,
  marginM: number,
  snapTol: number,
  stats?: HealStats
): GeoJSON.Polygon[] {
  const bboxes = lines.map(lineBBox);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [bx0, by0, bx1, by1] of bboxes) {
    if (bx0 < minX) minX = bx0;
    if (by0 < minY) minY = by0;
    if (bx1 > maxX) maxX = bx1;
    if (by1 > maxY) maxY = by1;
  }
  if (!Number.isFinite(minX)) return [];

  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);

  // Nombre de tuiles ≈ nLines / targetSegments, réparti en grille carrée : c'est
  // la découpe INITIALE (densité moyenne). Les tuiles localement trop denses sont
  // ensuite subdivisées récursivement (cf. `processRegion`).
  const nTiles = Math.max(1, Math.ceil(lines.length / Math.max(1, targetSegments)));
  const tilesPerAxis = Math.max(1, Math.ceil(Math.sqrt(nTiles)));
  const tileW = width / tilesPerAxis;
  const tileH = height / tilesPerAxis;

  const result: GeoJSON.Polygon[] = [];
  let droppedTiles = 0;
  let droppedSegments = 0;

  /**
   * Polygonise une région rectangulaire [rx0,ry0]–[rx1,ry1]. `idxs` = indices des
   * segments dont la bbox élargie (marge) recouvre déjà la région. Un polygone
   * n'est conservé que si son centroïde tombe dans le CŒUR de la région (bornes
   * demi-ouvertes) → chaque parcelle est comptée exactement une fois, quelle que
   * soit la profondeur de subdivision. Si la région est trop dense (> maxSeg) ou
   * si son noding échoue, elle est découpée en 2×2 et traitée récursivement, tant
   * que la profondeur et la taille minimale le permettent. C'est la clé de la
   * récupération des cœurs urbains denses noyés dans un fichier départemental.
   */
  const processRegion = (
    idxs: number[],
    rx0: number,
    ry0: number,
    rx1: number,
    ry1: number,
    depth: number
  ): void => {
    if (idxs.length === 0) return;

    const canSplit =
      depth < TILE_MAX_DEPTH &&
      rx1 - rx0 > TILE_MIN_SIZE_M &&
      ry1 - ry0 > TILE_MIN_SIZE_M;

    // Découpe préventive des régions manifestement trop denses avant même de
    // tenter le noding (coûteux et voué à l'échec au-delà de ~10⁴ segments).
    if (idxs.length > TILE_MAX_SEGMENTS && canSplit) {
      subdivide(idxs, rx0, ry0, rx1, ry1, depth);
      return;
    }

    const coords = idxs.map((i) => lines[i]);
    const owns = (cx: number, cy: number) =>
      cx >= rx0 && cx < rx1 && cy >= ry0 && cy < ry1;
    try {
      for (const poly of polygonizeChunk(coords, minArea, maxArea, owns, snapTol, stats)) {
        result.push(poly);
      }
    } catch (err) {
      // Noding impossible même après snap-rounding : on subdivise plutôt que de
      // perdre toute la région (comportement d'origine). En dernier recours
      // (région minimale atteinte), on l'abandonne en la comptabilisant.
      if (canSplit) {
        subdivide(idxs, rx0, ry0, rx1, ry1, depth);
      } else {
        droppedTiles++;
        droppedSegments += coords.length;
        console.warn(
          `[polygonize] région ${rx0.toFixed(0)},${ry0.toFixed(0)}–${rx1.toFixed(0)},${ry1.toFixed(0)} ignorée (${coords.length} segments, profondeur ${depth}) : ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    }
  };

  /** Découpe une région en 2×2 et répartit ses segments (bbox + marge) par quadrant. */
  const subdivide = (
    idxs: number[],
    rx0: number,
    ry0: number,
    rx1: number,
    ry1: number,
    depth: number
  ): void => {
    const mx = (rx0 + rx1) / 2;
    const my = (ry0 + ry1) / 2;
    const quads: Array<[number, number, number, number]> = [
      [rx0, ry0, mx, my],
      [mx, ry0, rx1, my],
      [rx0, my, mx, ry1],
      [mx, my, rx1, ry1],
    ];
    for (const [qx0, qy0, qx1, qy1] of quads) {
      const sub: number[] = [];
      for (const i of idxs) {
        const [bx0, by0, bx1, by1] = bboxes[i];
        // Segment retenu si sa bbox élargie de la marge recouvre le quadrant.
        if (bx1 + marginM >= qx0 && bx0 - marginM <= qx1 && by1 + marginM >= qy0 && by0 - marginM <= qy1) {
          sub.push(i);
        }
      }
      processRegion(sub, qx0, qy0, qx1, qy1, depth + 1);
    }
  };

  // Amorce sur la grille uniforme initiale (cœur = cellule, sans marge : le cœur
  // partitionne le plan, la marge n'intervient que pour COLLECTER les segments).
  for (let c = 0; c < tilesPerAxis; c++) {
    for (let r = 0; r < tilesPerAxis; r++) {
      const cx0 = minX + c * tileW;
      const cy0 = minY + r * tileH;
      const cx1 = c === tilesPerAxis - 1 ? maxX + 1e-6 : cx0 + tileW;
      const cy1 = r === tilesPerAxis - 1 ? maxY + 1e-6 : cy0 + tileH;
      const idxs: number[] = [];
      bboxes.forEach(([bx0, by0, bx1, by1], idx) => {
        if (bx1 + marginM >= cx0 && bx0 - marginM <= cx1 && by1 + marginM >= cy0 && by0 - marginM <= cy1) {
          idxs.push(idx);
        }
      });
      processRegion(idxs, cx0, cy0, cx1, cy1, 0);
    }
  }

  if (droppedTiles > 0) {
    console.warn(
      `[polygonize] ${droppedTiles} région(s) irrécupérable(s) (${droppedSegments} segments) après subdivision maximale.`
    );
  }
  return result;
}

/**
 * Node puis polygonise un ensemble de lignes (coordonnées EPSG:32628).
 * Retourne des polygones GeoJSON (anneaux [extérieur, trous...]).
 *
 * Au-delà de `tileThreshold` segments, bascule sur une polygonisation par
 * tuiles spatiales (le `UnaryUnion` global ne tient pas à cette échelle).
 */
/**
 * Clé canonique d'une ligne (orientation neutralisée) pour dédoublonner les
 * tracés dupliqués (copies Microstation : chaque limite dessinée deux fois).
 * Un doublon exact n'apporte rien au noding mais MASQUE le raccord des
 * extrémités pendantes : `healUndershoots` trouve le jumeau à distance 0 et
 * croit l'extrémité « déjà connectée » — le trou en T de quelques cm n'est
 * jamais refermé et les faces voisines fusionnent (cas sections 017/020 DYA).
 */
function canonicalLineKey(line: LineCoords): string {
  const fwd = line.map((c) => c[0] + "," + c[1]).join(";");
  const rev = line.map((c) => c[0] + "," + c[1]).reverse().join(";");
  return fwd < rev ? fwd : rev;
}

export function polygonizeLines(
  lines: LineCoords[],
  options: PolygonizeOptions = {}
): GeoJSON.Polygon[] {
  const minArea = options.minAreaM2 ?? 1;
  const maxArea = options.maxAreaM2 ?? Infinity;
  const tileThreshold = options.tileThreshold ?? TILE_THRESHOLD;
  const snapTol = options.snapToleranceM ?? SNAP_TOLERANCE_M;

  const seenKeys = new Set<string>();
  const usable: LineCoords[] = [];
  let duplicates = 0;
  for (const l of lines) {
    if (!Array.isArray(l) || l.length < 2) continue;
    const key = canonicalLineKey(l);
    if (seenKeys.has(key)) {
      duplicates++;
      continue;
    }
    seenKeys.add(key);
    usable.push(l);
  }
  if (duplicates > 0) {
    console.info(`[polygonize] ${duplicates} ligne(s) dupliquée(s) écartée(s) avant noding.`);
  }
  if (usable.length === 0) return [];

  const stats: HealStats = { endpointsClustered: 0, endpointsSnapped: 0 };
  const result =
    usable.length <= tileThreshold
      ? polygonizeChunk(usable, minArea, maxArea, undefined, snapTol, stats)
      : polygonizeTiled(
          usable,
          minArea,
          maxArea,
          options.tileTargetSegments ?? TILE_TARGET_SEGMENTS,
          options.tileMarginM ?? TILE_MARGIN_M,
          snapTol,
          stats
        );

  if (stats.endpointsClustered > 0 || stats.endpointsSnapped > 0) {
    console.info(
      `[polygonize] micro-trous raccordés (tol=${snapTol} m) : ` +
        `${stats.endpointsClustered} extrémité(s) regroupée(s), ` +
        `${stats.endpointsSnapped} raccrochée(s) à un segment/sommet` +
        (usable.length > tileThreshold ? " (occurrences par tuile, marges comprises)" : "")
    );
  }
  return result;
}
