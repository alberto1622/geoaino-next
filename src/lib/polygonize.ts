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
}

/**
 * Node puis polygonise un ensemble de lignes (coordonnées EPSG:32628).
 * Retourne des polygones GeoJSON (anneaux [extérieur, trous...]).
 */
export function polygonizeLines(
  lines: LineCoords[],
  options: PolygonizeOptions = {}
): GeoJSON.Polygon[] {
  const minArea = options.minAreaM2 ?? 1;
  const maxArea = options.maxAreaM2 ?? Infinity;

  const gf = new jsts.geom.GeometryFactory();
  const jstsLines = lines
    .filter((l) => Array.isArray(l) && l.length >= 2)
    .map((l) =>
      gf.createLineString(l.map(([x, y]: number[]) => new jsts.geom.Coordinate(x, y)))
    );

  if (jstsLines.length === 0) return [];

  const mls = gf.createMultiLineString(jstsLines);
  // UnaryUnion node les lignes (les casse à toutes les intersections),
  // pré-requis indispensable du Polygonizer.
  const noded = jsts.operation.union.UnaryUnionOp.union(mls);

  const polygonizer = new jsts.operation.polygonize.Polygonizer();
  polygonizer.add(noded);

  const result: GeoJSON.Polygon[] = [];
  const polys = polygonizer.getPolygons().toArray();
  for (const poly of polys) {
    const area = poly.getArea();
    if (area < minArea || area > maxArea) continue;
    result.push({ type: "Polygon", coordinates: jstsPolygonToCoordinates(poly) });
  }
  return result;
}
