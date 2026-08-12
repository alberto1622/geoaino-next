/**
 * geo-parse.ts — parsing shapefile (.shp/.dbf/.prj) extrait de
 * `src/app/api/upload-geo/route.ts` (extraction pure, zéro changement de
 * logique). Objectif : permettre à `run-shapefile-job.ts` (branche
 * "parcelles") de réutiliser exactement la même logique de lecture/
 * reprojection sans dupliquer le code.
 */
import * as shapefile from "shapefile";
import type { DxfIngestionReport } from "@/lib/parcelle-ingestion";

const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

export interface ParseResult {
  geoJson: string;
  featureCount: number;
  format: string;
  crs: string;
  /** Rapport d'ingestion DXF (étapes Microstation 4-10) — uniquement pour les fichiers DXF. */
  microstationReport?: DxfIngestionReport;
}

export function reprojectFeaturesToWgs84(features: unknown[]): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proj4: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("proj4");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    proj4 = mod.default ?? mod;
  } catch { return features; }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  if (typeof proj4 !== "function") return features;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const reproject = (pt: number[]): number[] => proj4(UTM28N, WGS84, [pt[0], pt[1]]) as number[];
  const reprojectRing = (ring: number[][]): number[][] => ring.map(reproject);

  return features.map((feat: unknown) => {
    const f = feat as { type: string; geometry: { type: string; coordinates: unknown } | null; properties: unknown };
    if (!f?.geometry) return feat;
    const { type, coordinates } = f.geometry;
    let newCoords: unknown;
    if (type === "Polygon") {
      newCoords = (coordinates as number[][][]).map(reprojectRing);
    } else if (type === "MultiPolygon") {
      newCoords = (coordinates as number[][][][]).map((p) => p.map(reprojectRing));
    } else if (type === "Point") {
      newCoords = reproject(coordinates as number[]);
    } else if (type === "MultiPoint" || type === "LineString") {
      newCoords = (coordinates as number[][]).map(reproject);
    } else if (type === "MultiLineString") {
      newCoords = (coordinates as number[][][]).map(reprojectRing);
    } else {
      return feat;
    }
    return { ...f, geometry: { ...f.geometry, coordinates: newCoords } };
  });
}

export async function parseShapefileBuffers(
  shpBuf: Buffer,
  dbfBuf?: Buffer,
  prjBuf?: Buffer
): Promise<ParseResult> {
  const features: unknown[] = [];
  const toArrayBuffer = (b: Buffer) =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const source = await shapefile.open(
    toArrayBuffer(shpBuf) as ArrayBuffer,
    dbfBuf ? (toArrayBuffer(dbfBuf) as ArrayBuffer) : undefined
  );

  let result = await source.read();
  while (!result.done) {
    if (result.value) features.push(result.value);
    result = await source.read();
  }

  let crs = "EPSG:4326";
  if (prjBuf) {
    const prj = prjBuf.toString("utf8");
    if (prj.includes("UTM") && prj.includes("28")) crs = "EPSG:32628";
  }

  const finalFeatures = crs === "EPSG:32628" ? reprojectFeaturesToWgs84(features) : features;

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features: finalFeatures }),
    featureCount: finalFeatures.length,
    format: "SHP",
    crs: "EPSG:4326",
  };
}
