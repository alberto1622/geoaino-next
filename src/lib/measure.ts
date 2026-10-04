/**
 * measure.ts — mesures géodésiques pour l'outil « Mesurer » des cartes.
 *
 * Calculs sur une sphère de rayon moyen (6 371 008,8 m),
 * mêmes formules que `@turf/length` (haversine) et `@turf/area` (aire
 * sphérique de Chamberlain & Duquette) : résultats identiques à turf, sans
 * embarquer turf dans le bundle client. Précision largement suffisante pour
 * une mesure à l'écran (écart < 0,5 % avec une mesure UTM à l'échelle d'une
 * parcelle ou d'une commune).
 */

const MEAN_RADIUS_M = 6371008.8; // rayon terrestre moyen, celui de turf 7 (length et area)
const rad = (d: number) => (d * Math.PI) / 180;

export type LngLat = [number, number];

/** Distance haversine entre deux points (m). */
function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * MEAN_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Longueur d'une polyligne (m). */
export function lengthMeters(pts: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
  return total;
}

/** Aire d'un anneau (m²), fermé ou non. */
export function areaSquareMeters(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const n = pts.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = pts[i];
    const middle = pts[(i + 1) % n];
    const upper = pts[(i + 2) % n];
    total += (rad(upper[0]) - rad(lower[0])) * Math.sin(rad(middle[1]));
  }
  return Math.abs((total * MEAN_RADIUS_M * MEAN_RADIUS_M) / 2);
}

const nf = (d: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: d });

/** « 845,32 m » ou « 12,481 km ». */
export function formatLength(m: number): string {
  return m < 1000 ? `${nf(2).format(m)} m` : `${nf(3).format(m / 1000)} km`;
}

/** « 512,40 m² (0,0512 ha) » ou « 3,215 km² (321,50 ha) ». */
export function formatArea(m2: number): string {
  const ha = m2 / 10000;
  return m2 < 1_000_000
    ? `${nf(2).format(m2)} m² (${nf(4).format(ha)} ha)`
    : `${nf(3).format(m2 / 1_000_000)} km² (${nf(2).format(ha)} ha)`;
}
