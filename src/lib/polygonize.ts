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
}

const TILE_THRESHOLD = Number(process.env.DXF_POLYGONIZE_TILE_THRESHOLD || 20000);
const TILE_TARGET_SEGMENTS = Number(process.env.DXF_POLYGONIZE_TILE_TARGET || 4000);
const TILE_MARGIN_M = Number(process.env.DXF_POLYGONIZE_TILE_MARGIN_M || 400);

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
// coordonnées à une grille de plus en plus grossière (1 mm → 1 cm → 5 cm) via
// GeometryPrecisionReducer, le réseau devient noded de façon cohérente. Un
// simple PrecisionModel sur la GeometryFactory ne suffit PAS : `createLineString`
// n'arrondit pas les coordonnées, seul le réducteur le fait.
const PRECISION_SCALES = (process.env.DXF_POLYGONIZE_PRECISION_SCALES || "1000,100,20")
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

function polygonizeChunk(
  lines: LineCoords[],
  minArea: number,
  maxArea: number,
  ownsPolygon?: (cx: number, cy: number) => boolean
): GeoJSON.Polygon[] {
  const gf = new jsts.geom.GeometryFactory();
  const jstsLines = lines
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
  marginM: number
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

  // Nombre de tuiles ≈ nLines / targetSegments, réparti en grille carrée.
  const nTiles = Math.max(1, Math.ceil(lines.length / Math.max(1, targetSegments)));
  const tilesPerAxis = Math.max(1, Math.ceil(Math.sqrt(nTiles)));
  const tileW = width / tilesPerAxis;
  const tileH = height / tilesPerAxis;

  const tileCol = (x: number) => Math.min(tilesPerAxis - 1, Math.max(0, Math.floor((x - minX) / tileW)));
  const tileRow = (y: number) => Math.min(tilesPerAxis - 1, Math.max(0, Math.floor((y - minY) / tileH)));

  // Affecte chaque segment aux tuiles dont la version élargie (marge) recouvre
  // sa bbox : un segment de bordure est ainsi présent dans toutes les tuiles
  // pouvant « posséder » une parcelle qui s'appuie dessus.
  const tileLines = new Map<string, number[]>();
  bboxes.forEach(([bx0, by0, bx1, by1], idx) => {
    const c0 = tileCol(bx0 - marginM);
    const c1 = tileCol(bx1 + marginM);
    const r0 = tileRow(by0 - marginM);
    const r1 = tileRow(by1 + marginM);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const key = `${c}_${r}`;
        const arr = tileLines.get(key);
        if (arr) arr.push(idx);
        else tileLines.set(key, [idx]);
      }
    }
  });

  const result: GeoJSON.Polygon[] = [];
  for (const [key, idxs] of tileLines) {
    const [c, r] = key.split("_").map(Number);
    const tileLinesCoords = idxs.map((i) => lines[i]);
    // N'attribue un polygone à cette tuile que si son centroïde y tombe : une
    // parcelle reconstruite dans plusieurs tuiles élargies n'est gardée qu'une fois.
    const owns = (cx: number, cy: number) => tileCol(cx) === c && tileRow(cy) === r;
    // Isolation par tuile : une `TopologyException` sur une tuile ne doit pas
    // faire perdre toutes les autres. On saute la tuile fautive (rare grâce au
    // modèle de précision) plutôt que d'abandonner tout le calque.
    try {
      for (const poly of polygonizeChunk(tileLinesCoords, minArea, maxArea, owns)) {
        result.push(poly);
      }
    } catch (err) {
      console.warn(
        `[polygonize] tuile ${key} ignorée (${tileLinesCoords.length} segments) : ${
          err instanceof Error ? err.message : err
        }`
      );
    }
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
export function polygonizeLines(
  lines: LineCoords[],
  options: PolygonizeOptions = {}
): GeoJSON.Polygon[] {
  const minArea = options.minAreaM2 ?? 1;
  const maxArea = options.maxAreaM2 ?? Infinity;
  const tileThreshold = options.tileThreshold ?? TILE_THRESHOLD;

  const usable = lines.filter((l) => Array.isArray(l) && l.length >= 2);
  if (usable.length === 0) return [];

  if (usable.length <= tileThreshold) {
    return polygonizeChunk(usable, minArea, maxArea);
  }

  return polygonizeTiled(
    usable,
    minArea,
    maxArea,
    options.tileTargetSegments ?? TILE_TARGET_SEGMENTS,
    options.tileMarginM ?? TILE_MARGIN_M
  );
}
