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
