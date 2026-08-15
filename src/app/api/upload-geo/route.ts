import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { parseDGN } from "@/lib/dgn-parser";
import { convertDgnToDxf } from "@/lib/dgn-to-dxf";
import { ingestDxfToParcelles, parcellesToFeatureCollection } from "@/lib/parcelle-ingestion";
import { assignNicad2026FromCommunes } from "@/lib/cadastre/assign-nicad-2026";
import { parseShapefileBuffers, type ParseResult } from "@/lib/import/geo-parse";

/**
 * Plafond du nombre de features renvoyées à l'interface (et donc transmises à
 * `/api/analyses`, stockées, puis rendues sur la carte). Un DXF cadastral peut
 * produire 100 000+ parcelles : renvoyer tout en un seul GeoJSON sature le
 * transfert HTTP, la sérialisation et surtout le navigateur (l'onglet « tourne »
 * sans fin). On tronque l'aperçu **après** avoir construit la totalité (les
 * compteurs/rapport restent exacts). 0 = aucun plafond.
 */
const MAX_ANALYSIS_FEATURES = Number(process.env.MAX_ANALYSIS_FEATURES || 8000);

/**
 * Ingestion DXF via le pipeline "parcelle-ingestion" (nomenclature DGID des
 * calques Microstation, jointure spatiale numéro/dénomination ⇄ parcelle,
 * détection doublons/chevauchements — étapes 4 à 10 de
 * "Etapes de travail sur Microstation.md").
 *
 * TOUT fichier DXF passe obligatoirement par ce processus de construction des
 * NICAD : il n'y a pas de repli "géométrie brute" (`parseDXF`). Un DXF sans
 * parcelle exploitable retourne le résultat d'ingestion vide accompagné de son
 * rapport (`microstationReport`) expliquant pourquoi aucune parcelle/NICAD n'a
 * pu être construit — aucun DXF ne contourne le pipeline NICAD.
 *
 * Le Syscol (préfixe 8 chiffres du NICAD) et la section sont résolus par
 * jointure spatiale (`assignNicad2026FromCommunes`) : prioritairement sur
 * `limite_section` (table QA de /cadastre/sections, Syscol + section
 * ensemble), avec repli sur `cad_communes_2026` (Syscol seul, commune 2026
 * contenant la parcelle) là où aucune section n'a encore été construite.
 */
async function parseDxfAsParcelles(buf: Buffer): Promise<ParseResult> {
  const ingestion = await assignNicad2026FromCommunes(
    await ingestDxfToParcelles(buf, "input.dxf"),
  );

  const fc = parcellesToFeatureCollection(ingestion.parcelles);
  const totalBuilt = fc.features.length;

  // Tronque l'aperçu renvoyé à l'interface si le volume dépasse le plafond, pour
  // ne pas saturer le transfert/parsing/rendu navigateur. Le tableau de parcelles
  // est déjà en mémoire : la troncature est gratuite (pas de re-parsing JSON).
  const truncated = MAX_ANALYSIS_FEATURES > 0 && totalBuilt > MAX_ANALYSIS_FEATURES;
  const features = truncated ? fc.features.slice(0, MAX_ANALYSIS_FEATURES) : fc.features;

  if (truncated) {
    ingestion.report.warnings.unshift(
      `Aperçu tronqué : ${totalBuilt} parcelles construites, seules les ${MAX_ANALYSIS_FEATURES} ` +
        `premières sont renvoyées à l'interface (analyse/carte) pour éviter de saturer le navigateur. ` +
        `Les compteurs du rapport portent sur la totalité. Persistance complète à venir (import en lot).`,
    );
  }

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features }),
    featureCount: features.length,
    format: "DXF",
    crs: "EPSG:4326",
    microstationReport: ingestion.report,
  };
}

/**
 * Traitement d'un fichier DGN :
 * 1. Si un convertisseur DGN→DXF externe est configuré (`DGN_TO_DXF_BIN`, p.ex.
 *    GDAL avec driver DGNv8, ou MicroStation en batch), on l'utilise pour
 *    obtenir un DXF (gère le DGN v8), puis on route vers le pipeline d'ingestion
 *    complet (`parseDxfAsParcelles` : calques Microstation, NICAD, jointures).
 * 2. Sinon (non configuré) ou en cas d'échec, on retombe sur GDAL (`parseDGN`),
 *    qui lit le DGN v7 et affiche un message d'aide explicite pour le DGN v8.
 */
async function parseDgnFile(buf: Buffer): Promise<ParseResult> {
  try {
    const dxfBuf = await convertDgnToDxf(buf);
    if (dxfBuf) {
      const res = await parseDxfAsParcelles(dxfBuf);
      return { ...res, format: "DGN" }; // provenance : source DGN, convertie en DXF
    }
  } catch (err) {
    console.warn("[upload-geo] Conversion DGN→DXF externe échouée, repli sur GDAL:", err);
  }
  return parseDGN(buf);
}

async function parseZip(buffer: Buffer): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir);

  // Tout DXF présent dans le ZIP doit passer par le processus de construction
  // des NICAD (au même titre qu'un DXF déposé directement), avant tout autre
  // format : on le route donc vers le pipeline d'ingestion `parcelle-ingestion`.
  const dxfInZip = files.find((f) => f.toLowerCase().endsWith(".dxf"));
  if (dxfInZip) {
    const buf = Buffer.from(await zip.files[dxfInZip].async("arraybuffer"));
    return parseDxfAsParcelles(buf);
  }

  // Un DGN compressé est routé vers le même pipeline (conversion DGN→DXF puis NICAD).
  const dgnInZip = files.find((f) => f.toLowerCase().endsWith(".dgn"));
  if (dgnInZip) {
    const buf = Buffer.from(await zip.files[dgnInZip].async("arraybuffer"));
    return parseDgnFile(buf);
  }

  const geojsonFile = files.find(
    (f) => f.toLowerCase().endsWith(".geojson") || f.toLowerCase().endsWith(".json")
  );
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
    throw new Error("Aucun fichier SHP, GeoJSON, DXF ou DGN trouvé dans le ZIP");
  }

  const allFeatures: unknown[] = [];
  let crs = "EPSG:4326";

  for (const shpFile of shpFiles) {
    const base = shpFile.slice(0, -4); // remove .shp
    const dbfFile = files.find((f) => f.toLowerCase() === (base + ".dbf").toLowerCase());
    const prjFile = files.find((f) => f.toLowerCase() === (base + ".prj").toLowerCase());

    const shpBuf = Buffer.from(await zip.files[shpFile].async("arraybuffer"));
    const dbfBuf = dbfFile
      ? Buffer.from(await zip.files[dbfFile].async("arraybuffer"))
      : undefined;
    const prjBuf = prjFile
      ? Buffer.from(await zip.files[prjFile].async("arraybuffer"))
      : undefined;

    const result = await parseShapefileBuffers(shpBuf, dbfBuf, prjBuf);
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];

    if (!files.length) {
      return NextResponse.json({ error: "Aucun fichier fourni" }, { status: 400 });
    }

    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
    const prjFile = files.find((f) => f.name.toLowerCase().endsWith(".prj"));
    const zipFile = files.find((f) => f.name.toLowerCase().endsWith(".zip"));
    const geoJsonFile = files.find(
      (f) =>
        f.name.toLowerCase().endsWith(".geojson") ||
        f.name.toLowerCase().endsWith(".json")
    );
    const kmlFile = files.find((f) => f.name.toLowerCase().endsWith(".kml"));
    const csvFile = files.find((f) => f.name.toLowerCase().endsWith(".csv"));
    const dgnFile = files.find((f) => f.name.toLowerCase().endsWith(".dgn"));
    const dxfFile = files.find((f) => f.name.toLowerCase().endsWith(".dxf"));

    let result: ParseResult;

    if (shpFile) {
      const shpBuf = Buffer.from(await shpFile.arrayBuffer());
      const dbfBuf = dbfFile
        ? Buffer.from(await dbfFile.arrayBuffer())
        : undefined;
      const prjBuf = prjFile
        ? Buffer.from(await prjFile.arrayBuffer())
        : undefined;
      result = await parseShapefileBuffers(shpBuf, dbfBuf, prjBuf);
    } else if (zipFile) {
      const buf = Buffer.from(await zipFile.arrayBuffer());
      result = await parseZip(buf);
    } else if (geoJsonFile) {
      const text = await geoJsonFile.text();
      const parsed = JSON.parse(text);
      result = {
        geoJson: text,
        featureCount: (parsed.features || []).length,
        format: "GeoJSON",
        crs: "EPSG:4326",
      };
    } else if (kmlFile) {
      const text = await kmlFile.text();
      result = await parseKML(text);
    } else if (csvFile) {
      const text = await csvFile.text();
      result = parseCSV(text);
    } else if (dgnFile) {
      const buf = Buffer.from(await dgnFile.arrayBuffer());
      result = await parseDgnFile(buf);
    } else if (dxfFile) {
      const buf = Buffer.from(await dxfFile.arrayBuffer());
      result = await parseDxfAsParcelles(buf);
    } else {
      return NextResponse.json(
        { error: "Format non supporté. Utilisez SHP, GeoJSON, ZIP, KML, CSV, DGN ou DXF." },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[upload-geo]", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}

async function parseKML(content: string): Promise<ParseResult> {
  const features: unknown[] = [];
  const placemarkRegex = /<Placemark>([\s\S]*?)<\/Placemark>/gi;
  const nameRegex = /<name>([\s\S]*?)<\/name>/i;
  const coordsRegex = /<coordinates>([\s\S]*?)<\/coordinates>/i;

  let match;
  while ((match = placemarkRegex.exec(content)) !== null) {
    const block = match[1];
    const name = nameRegex.exec(block)?.[1]?.trim() || "";
    const coordsStr = coordsRegex.exec(block)?.[1]?.trim() || "";

    if (!coordsStr) continue;
    const coords = coordsStr
      .split(/\s+/)
      .map((c) => c.split(",").map(Number).slice(0, 2))
      .filter((c) => c.length === 2 && !isNaN(c[0]) && !isNaN(c[1]));

    if (coords.length >= 3) {
      if (
        coords[0][0] !== coords[coords.length - 1][0] ||
        coords[0][1] !== coords[coords.length - 1][1]
      ) {
        coords.push(coords[0]);
      }
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [coords] },
        properties: { name },
      });
    }
  }

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features }),
    featureCount: features.length,
    format: "KML",
    crs: "EPSG:4326",
  };
}

function parseCSV(content: string): ParseResult {
  const lines = content.trim().split("\n");
  if (lines.length < 2) {
    return {
      geoJson: JSON.stringify({ type: "FeatureCollection", features: [] }),
      featureCount: 0,
      format: "CSV",
      crs: "EPSG:4326",
    };
  }

  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  const lonIdx = headers.findIndex((h) => /^(lon|longitude|lng|x)$/i.test(h));
  const latIdx = headers.findIndex((h) => /^(lat|latitude|y)$/i.test(h));

  if (lonIdx === -1 || latIdx === -1) {
    throw new Error("CSV doit contenir des colonnes lat/lon");
  }

  const features = lines
    .slice(1)
    .map((line) => {
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
    })
    .filter(
      (f) =>
        !isNaN(f.geometry.coordinates[0]) &&
        !isNaN(f.geometry.coordinates[1])
    );

  return {
    geoJson: JSON.stringify({ type: "FeatureCollection", features }),
    featureCount: features.length,
    format: "CSV",
    crs: "EPSG:4326",
  };
}
