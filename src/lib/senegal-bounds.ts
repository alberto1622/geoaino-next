/**
 * Filtre les entités dont le centroïde tombe en dehors des limites
 * administratives du Sénégal — utile pour écarter les parcelles mal
 * géoréférencées (mauvais fuseau UTM, erreur de saisie, etc.) avant
 * affichage sur la carte.
 *
 * La bbox inclut une marge de tolérance autour des frontières réelles
 * du Sénégal (≈ -17.6/-11.3 lon, 12.2/16.8 lat).
 */

export const SENEGAL_BBOX = {
  minLon: -17.6,
  maxLon: -11.3,
  minLat: 12.2,
  maxLat: 16.8,
};

export function isInsideSenegal(lon: number, lat: number): boolean {
  return (
    lon >= SENEGAL_BBOX.minLon &&
    lon <= SENEGAL_BBOX.maxLon &&
    lat >= SENEGAL_BBOX.minLat &&
    lat <= SENEGAL_BBOX.maxLat
  );
}

interface AnyFeature {
  type: string;
  geometry: { type: string; coordinates: unknown } | { type: string; geometries: unknown[] } | null;
  properties?: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface AnyFeatureCollection {
  type: string;
  features: AnyFeature[];
  [key: string]: unknown;
}

function flattenCoords(coords: unknown): number[][] {
  if (!Array.isArray(coords)) return [];
  if (typeof coords[0] === "number" && typeof coords[1] === "number") return [coords as number[]];
  return (coords as unknown[]).flatMap((c) => flattenCoords(c));
}

function getFeatureCentroid(geometry: AnyFeature["geometry"]): [number, number] | null {
  if (!geometry) return null;

  let points: number[][];
  if (geometry.type === "GeometryCollection") {
    points = ((geometry as { geometries: { coordinates: unknown }[] }).geometries ?? [])
      .flatMap((g) => flattenCoords(g.coordinates));
  } else {
    points = flattenCoords((geometry as { coordinates: unknown }).coordinates);
  }

  if (points.length === 0) return null;

  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of points) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / points.length, sumLat / points.length];
}

export function filterOutOfSenegal<T extends AnyFeatureCollection>(
  fc: T
): { kept: T; removedCount: number; removedFeatures: AnyFeature[] } {
  const features = fc.features || [];
  const kept: AnyFeature[] = [];
  const removedFeatures: AnyFeature[] = [];

  for (const feature of features) {
    const centroid = getFeatureCentroid(feature?.geometry ?? null);
    // Si le centroïde est introuvable (géométrie nulle/invalide), on conserve
    // la feature : ce n'est pas le rôle de ce filtre de la rejeter.
    if (!centroid || isInsideSenegal(centroid[0], centroid[1])) {
      kept.push(feature);
    } else {
      removedFeatures.push(feature);
    }
  }

  return {
    kept: { ...fc, features: kept } as T,
    removedCount: removedFeatures.length,
    removedFeatures,
  };
}
