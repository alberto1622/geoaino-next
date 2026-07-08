"use server";
import * as shapefile from "shapefile";
import JSZip from "jszip";
import { parseStringPromise } from "xml2js";

const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

function reprojectFeaturesToWgs84(features: unknown[]): unknown[] {
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

export interface ParseResult {
  geoJson: string;
  featureCount: number;
  format: string;
  crs: string;
}

export async function parseGeoFile(
  fileBuffer: Buffer,
  fileName: string,
  dbfBuffer?: Buffer,
  prjBuffer?: Buffer
): Promise<ParseResult> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "geojson" || ext === "json") {
    const text = fileBuffer.toString("utf8");
    const parsed = JSON.parse(text);
    const features = parsed.features || [];
    return {
      geoJson: text,
      featureCount: features.length,
      format: "GeoJSON",
      crs: "EPSG:4326",
    };
  }

  if (ext === "shp") {
    return await parseShapefile(fileBuffer, dbfBuffer, prjBuffer);
  }

  if (ext === "zip") {
    return await parseZipFile(fileBuffer);
  }

  if (ext === "kml") {
    return await parseKML(fileBuffer.toString("utf8"));
  }

  if (ext === "csv") {
    return await parseCSV(fileBuffer.toString("utf8"));
  }

  throw new Error(`Format non supporté: .${ext}`);
}

async function parseShapefile(
  shpBuffer: Buffer,
  dbfBuffer?: Buffer,
  prjBuffer?: Buffer
): Promise<ParseResult> {
  const features: unknown[] = [];
  const source = await shapefile.open(
    shpBuffer as unknown as ArrayBuffer,
    dbfBuffer as unknown as ArrayBuffer | undefined
  );

  let result = await source.read();
  while (!result.done) {
    if (result.value) features.push(result.value);
    result = await source.read();
  }

  let crs = "EPSG:4326";
  if (prjBuffer) {
    const prjText = prjBuffer.toString("utf8");
    if (prjText.includes("UTM") && prjText.includes("28")) crs = "EPSG:32628";
    else if (prjText.includes("GEOGRAPHIC") || prjText.includes("WGS_1984")) crs = "EPSG:4326";
  }

  const finalFeatures = crs === "EPSG:32628" ? reprojectFeaturesToWgs84(features) : features;

  const geoJson = JSON.stringify({
    type: "FeatureCollection",
    features: finalFeatures,
  });

  return { geoJson, featureCount: finalFeatures.length, format: "SHP", crs: "EPSG:4326" };
}

async function parseZipFile(buffer: Buffer): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir);

  console.log(`[geoParser] ZIP contient ${files.length} fichier(s):`, files);

  const geojsonFile = files.find((f) => f.toLowerCase().endsWith(".geojson") || f.toLowerCase().endsWith(".json"));
  if (geojsonFile) {
    const content = await zip.files[geojsonFile].async("string");
    const parsed = JSON.parse(content);
    return {
      geoJson: content,
      featureCount: (parsed.features || []).length,
      format: "GeoJSON",
      crs: "EPSG:4326",
    };
  }

  const shpFiles = files.filter((f) => f.toLowerCase().endsWith(".shp"));
  if (shpFiles.length === 0) {
    throw new Error("Aucun fichier SHP ou GeoJSON trouvé dans le ZIP");
  }

  const allFeatures: unknown[] = [];
  let crs = "EPSG:4326";

  for (const shpFile of shpFiles) {
    const base = shpFile.slice(0, -4); // remove .shp
    const dbfFile = files.find((f) => f.toLowerCase() === (base + ".dbf").toLowerCase());
    const prjFile = files.find((f) => f.toLowerCase() === (base + ".prj").toLowerCase());

    const shpBuf = Buffer.from(await zip.files[shpFile].async("arraybuffer"));
    const dbfBuf = dbfFile ? Buffer.from(await zip.files[dbfFile].async("arraybuffer")) : undefined;
    const prjBuf = prjFile ? Buffer.from(await zip.files[prjFile].async("arraybuffer")) : undefined;

    const result = await parseShapefile(shpBuf, dbfBuf, prjBuf);
    const parsed = JSON.parse(result.geoJson);
    // Boucle (pas de push(...spread)) : au-delà de ~100k features, le spread
    // dépasse la limite d'arguments d'appel (RangeError: Maximum call stack).
    for (const f of parsed.features ?? []) allFeatures.push(f);
    if (result.crs !== "EPSG:4326") crs = result.crs;
  }

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features: allFeatures }),
    featureCount: allFeatures.length,
    format: "SHP",
    crs,
  };
}

async function parseKML(content: string): Promise<ParseResult> {
  const features: unknown[] = [];

  try {
    const parsed = await parseStringPromise(content);
    const placemarks = parsed?.kml?.Document?.[0]?.Placemark ||
                       parsed?.kml?.Folder?.[0]?.Placemark || [];

    for (const pm of placemarks) {
      const name = pm?.name?.[0] || "";
      const extData = pm?.ExtendedData?.[0]?.Data || [];
      const props: Record<string, unknown> = { name };

      for (const d of extData) {
        if (d["$"]?.name) props[d["$"].name] = d?.value?.[0];
      }

      const polygon = pm?.Polygon?.[0];
      if (polygon) {
        const coordsStr = polygon?.outerBoundaryIs?.[0]?.LinearRing?.[0]?.coordinates?.[0] || "";
        const coords = coordsStr
          .trim()
          .split(/\s+/)
          .map((c: string) => c.split(",").map(Number).slice(0, 2));

        if (coords.length >= 3) {
          if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
            coords.push(coords[0]);
          }
          features.push({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [coords] },
            properties: props,
          });
        }
      }
    }
  } catch {
    throw new Error("Erreur lors du parsing KML");
  }

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features }),
    featureCount: features.length,
    format: "KML",
    crs: "EPSG:4326",
  };
}

async function parseCSV(content: string): Promise<ParseResult> {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return { geoJson: JSON.stringify({ type: "FeatureCollection", features: [] }), featureCount: 0, format: "CSV", crs: "EPSG:4326" };

  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  const lonIdx = headers.findIndex((h) => /^(lon|longitude|lng|x)$/i.test(h));
  const latIdx = headers.findIndex((h) => /^(lat|latitude|y)$/i.test(h));

  if (lonIdx === -1 || latIdx === -1) {
    throw new Error("CSV doit contenir des colonnes lat/lon ou latitude/longitude");
  }

  const features = lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/"/g, ""));
    const props: Record<string, unknown> = {};
    headers.forEach((h, i) => { props[h] = values[i]; });

    const lon = parseFloat(values[lonIdx]);
    const lat = parseFloat(values[latIdx]);

    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: props,
    };
  }).filter((f) => !isNaN(f.geometry.coordinates[0]) && !isNaN(f.geometry.coordinates[1]));

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features }),
    featureCount: features.length,
    format: "CSV",
    crs: "EPSG:4326",
  };
}
