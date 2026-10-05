/**
 * map-selection.ts — outil « Sélectionner » des cartes (à la manière d'ArcGIS /
 * QGIS) : curseur dédié, opération selon les touches de modification, point
 * intérieur d'une géométrie servant de localisateur côté serveur.
 */

/**
 * Opération de sélection :
 *  - `replace` : clic / rectangle seul → la sélection est remplacée ;
 *  - `add`     : Maj enfoncée → ajout à la sélection ;
 *  - `remove`  : Ctrl (⌘ sur Mac) enfoncé → retrait de la sélection.
 * Mêmes conventions que l'outil « Sélectionner des entités » de QGIS.
 */
export type SelectOp = "replace" | "add" | "remove";

export function selectOpFromEvent(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectOp {
  if (e.ctrlKey || e.metaKey) return "remove";
  if (e.shiftKey) return "add";
  return "replace";
}

/**
 * Curseur « flèche + cadre pointillé » (SVG en data-URI, point chaud en 2,2),
 * repli `default` : signale visuellement que le clic sélectionne au lieu
 * d'identifier, comme le curseur de sélection des SIG bureautiques.
 */
export const SELECT_CURSOR =
  "url(\"data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<rect x="9.5" y="9.5" width="13" height="13" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="2.5 2"/>' +
      '<path d="M2 2 L2 16 L6 12.5 L8.8 18.5 L11 17.5 L8.3 11.6 L13 11.6 Z" fill="#ffffff" stroke="#111827" stroke-width="1.2" stroke-linejoin="round"/>' +
      "</svg>",
  ) +
  "\") 2 2, default";

/**
 * Plafond d'une sélection : au-delà, la table attributaire et les requêtes
 * d'édition (un localisateur par parcelle) deviennent lourdes. Le rectangle
 * renvoie au plus MAX_SELECTION + 1 entités pour signaler le dépassement.
 */
export const MAX_SELECTION = 500;

/** Couleur du rectangle de sélection (bleu « sélection »). */
export const SELECT_COLOR = "#2563eb";

type Ring = number[][];

/**
 * Point garanti intérieur à un Polygon / MultiPolygon (règle pair-impair,
 * trous compris) : balayage horizontal à mi-hauteur de l'emprise du plus
 * grand polygone, puis milieu du plus large segment intérieur. Le centroïde
 * ne convient pas : il tombe hors des parcelles concaves (en L, en U), et le
 * serveur localise la parcelle par point-dans-polygone.
 * `null` pour tout autre type ou une géométrie dégénérée.
 */
export function interiorPoint(geom: unknown): [number, number] | null {
  const g = geom as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) return null;
  const polys: Ring[][] =
    g.type === "Polygon" ? [g.coordinates as Ring[]] : g.type === "MultiPolygon" ? (g.coordinates as Ring[][]) : [];

  let best: [number, number] | null = null;
  let bestWidth = -1;
  for (const rings of polys) {
    const outer = rings[0];
    if (!outer || outer.length < 3) continue;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of outer) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!(maxY > minY)) continue;
    // Légèrement décalé du milieu pour ne pas passer exactement par un sommet.
    const y = minY + (maxY - minY) * 0.5013;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > bestWidth) {
        bestWidth = w;
        best = [(xs[k] + xs[k + 1]) / 2, y];
      }
    }
  }
  return best;
}

// ── Tests géométriques pour les cartes sans requête de rendu (Leaflet) ──────
// MapLibre sait interroger ses tuiles (`queryRenderedFeatures`) ; une carte
// Leaflet, non : la sélection y est calculée sur les géométries GeoJSON.

/** Emprise [w, s, e, n] = [minLng, minLat, maxLng, maxLat]. */
export type BBox = [number, number, number, number];

function polygonsOf(geom: unknown): Ring[][] {
  const g = geom as { type?: string; coordinates?: unknown } | null;
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === "Polygon") return [g.coordinates as Ring[]];
  if (g.type === "MultiPolygon") return g.coordinates as Ring[][];
  return [];
}

/** Emprise d'un Polygon / MultiPolygon (`null` si vide ou autre type). */
export function geometryBBox(geom: unknown): BBox | null {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of polygonsOf(geom)) {
    for (const [x, y] of rings[0] ?? []) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return b[0] <= b[2] ? b : null;
}

export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Point dans un polygone (anneaux en règle pair-impair : trous exclus). */
function pointInRings(x: number, y: number, rings: Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}

/** Point [lng, lat] à l'intérieur d'un Polygon / MultiPolygon. */
export function pointInGeometry(pt: [number, number], geom: unknown): boolean {
  return polygonsOf(geom).some((rings) => pointInRings(pt[0], pt[1], rings));
}

/** Segments [p1, p2] et [p3, p4] sécants (orientations opposées des deux côtés). */
function segmentsCross(p1: number[], p2: number[], p3: number[], p4: number[]): boolean {
  const o = (a: number[], b: number[], c: number[]) =>
    Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p1, p2, p3) !== o(p1, p2, p4) && o(p3, p4, p1) !== o(p3, p4, p2);
}

/**
 * Le polygone touche-t-il le rectangle ? Sémantique « intersecte » du
 * rectangle de sélection QGIS : une entité à cheval sur le bord est prise.
 * Trois cas : un sommet du polygone dans le rectangle, un coin du rectangle
 * dans le polygone (rectangle tracé à l'intérieur d'une grande entité), ou un
 * bord du polygone qui traverse un bord du rectangle.
 */
export function geometryIntersectsBBox(geom: unknown, box: BBox): boolean {
  const [w, s, e, n] = box;
  const corners = [[w, s], [e, s], [e, n], [w, n]];
  for (const rings of polygonsOf(geom)) {
    for (const ring of rings) {
      for (const [x, y] of ring) if (x >= w && x <= e && y >= s && y <= n) return true;
    }
    if (corners.some(([x, y]) => pointInRings(x, y, rings))) return true;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        for (let k = 0; k < 4; k++) {
          if (segmentsCross(ring[i - 1], ring[i], corners[k], corners[(k + 1) % 4])) return true;
        }
      }
    }
  }
  return false;
}
