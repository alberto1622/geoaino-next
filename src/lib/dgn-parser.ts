import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, rm, mkdtemp, unlink } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  filterDxfCadastralFeatures,
  filterUsefulFeatures,
  normalizeFeatureCollection,
  type FeatureCollection,
} from "./cadastral-filter";

const execFileAsync = promisify(execFile);

let ogr2ogrPath: string | undefined;
let ogrInfoPath: string | undefined;

function resolveTool(binaryName: "ogr2ogr" | "ogrinfo"): string {
  const candidates: string[] = [];
  const envVar = binaryName === "ogr2ogr" ? "OGR2OGR_PATH" : "OGRINFO_PATH";
  if (process.env[envVar]) candidates.push(process.env[envVar] as string);

  if (process.platform === "win32") {
    const pgRoot = "C:\\Program Files\\PostgreSQL";
    if (existsSync(pgRoot)) {
      for (const version of readdirSync(pgRoot)) {
        candidates.push(path.join(pgRoot, version, "bin", `${binaryName}.exe`));
      }
    }
    candidates.push(
      `C:\\OSGeo4W\\bin\\${binaryName}.exe`,
      `C:\\Program Files\\GDAL\\${binaryName}.exe`
    );
  }

  return candidates.find((c) => existsSync(c)) ?? binaryName;
}

export function resolveOgr2Ogr(): string {
  if (!ogr2ogrPath) ogr2ogrPath = resolveTool("ogr2ogr");
  return ogr2ogrPath;
}

function resolveOgrInfo(): string {
  if (!ogrInfoPath) ogrInfoPath = resolveTool("ogrinfo");
  return ogrInfoPath;
}

const WGS84 = "EPSG:4326";
const CANDIDATE_CRS = ["", "EPSG:32628", "EPSG:4326", "EPSG:32629"];

export interface ParseResult {
  geoJson: string;
  featureCount: number;
  format: string;
  crs: string;
}

async function ogrInfo(inputPath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(resolveOgrInfo(), ["-al", "-so", inputPath], {
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 20,
    });
    return stdout || stderr || "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function isDgnV8Error(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes("dgnv8") || msg.includes("recognized as a dgnv8 dataset");
}

function getDgnV8Message(): string {
  return [
    "FORMAT DGN v8 NON LISIBLE PAR CE SERVEUR",
    "",
    "Cause : fichier DGN v8 (Microstation V8). Le driver DGNv8 n'est pas",
    "disponible dans cette build GDAL, et aucun convertisseur externe n'est",
    "configuré (DGN_TO_DXF_BIN).",
    "",
    "SOLUTION UTILISATEUR (immédiate) :",
    "1. Ouvrir le fichier dans Microstation.",
    "2. Enregistrer sous DXF, SHP, GeoJSON ou GeoPackage.",
    "3. Réimporter le fichier converti dans GEO-AINO.",
    "",
    "SOLUTION ADMIN (automatisation DGN v8) :",
    "Configurer DGN_TO_DXF_BIN / DGN_TO_DXF_ARGS pour pointer sur un",
    "convertisseur capable de LIRE le DGN v8 (GDAL compilé avec le driver",
    "DGNv8/ODA, ou MicroStation en batch). Voir SETUP.md.",
    "",
    "Formats déjà acceptés directement : DXF, SHP, GeoJSON, GeoPackage.",
  ].join("\n");
}

async function parseWithOgr2Ogr(buffer: Buffer, format: "DGN" | "DXF"): Promise<ParseResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-ogr-"));
  const ext = format.toLowerCase();
  const inputPath = path.join(dir, `input.${ext}`);
  const outputPath = path.join(dir, "output.geojson");

  try {
    await writeFile(inputPath, buffer);

    const info = await ogrInfo(inputPath);

    if (format === "DGN" && isDgnV8Error(info)) {
      throw new Error(getDgnV8Message());
    }

    let bestFc: FeatureCollection | null = null;
    let bestUsefulCount = 0;
    let lastError = "";

    for (const sourceCRS of CANDIDATE_CRS) {
      if (existsSync(outputPath)) await unlink(outputPath);

      const args = [
        "-f", "GeoJSON",
        "-skipfailures",
        "-explodecollections",
        "-nlt", "PROMOTE_TO_MULTI",
        "-t_srs", WGS84,
      ];
      if (sourceCRS) args.push("-s_srs", sourceCRS);
      args.push(outputPath, inputPath);

      try {
        await execFileAsync(resolveOgr2Ogr(), args, {
          timeout: 180000,
          maxBuffer: 1024 * 1024 * 100,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        if (format === "DGN" && isDgnV8Error(msg)) throw new Error(getDgnV8Message());
        console.warn(`[geo-parser] ${format}: essai CRS=${sourceCRS || "auto"} échoué:`, msg);
        continue;
      }

      if (!existsSync(outputPath)) continue;

      const text = await readFile(outputPath, "utf-8");
      const rawFc = normalizeFeatureCollection(JSON.parse(text));
      const rawCount = rawFc.features.length;

      if (rawCount === 0) {
        console.warn(`[geo-parser] ${format}: CRS=${sourceCRS || "auto"}, 0 entité(s) brute(s) (CRS source probablement incorrect) — essai suivant.`);
        continue;
      }

      let usefulFc: FeatureCollection;
      try {
        usefulFc = format === "DXF" ? filterDxfCadastralFeatures(rawFc) : filterUsefulFeatures(rawFc);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[geo-parser] ${format}: CRS=${sourceCRS || "auto"}, ${rawCount} entité(s) brute(s), filtrage échoué: ${lastError}`);
        continue;
      }
      const usefulCount = usefulFc.features.length;

      console.log(`[geo-parser] ${format}: CRS=${sourceCRS || "auto"}, ${rawCount} entité(s) brute(s), ${usefulCount} utile(s)`);

      if (usefulCount > bestUsefulCount) {
        bestFc = usefulFc;
        bestUsefulCount = usefulCount;
      }

      if (usefulCount > 0) break;
    }

    if (!bestFc || bestUsefulCount === 0) {
      if (format === "DGN") throw new Error(getDgnV8Message());
      throw new Error(lastError || `Aucune entité exploitable extraite du ${format}.`);
    }

    return {
      geoJson: JSON.stringify(bestFc),
      featureCount: bestFc.features.length,
      format,
      crs: WGS84,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function parseDGN(buffer: Buffer): Promise<ParseResult> {
  return parseWithOgr2Ogr(buffer, "DGN");
}

export async function parseDXF(buffer: Buffer): Promise<ParseResult> {
  return parseWithOgr2Ogr(buffer, "DXF");
}

/**
 * Repli DGN v7 → buffer DXF via le GDAL embarqué (`ogr2ogr -f DXF`). Le driver
 * DGN standard de GDAL lit le v7 (ISFF) mais PAS le v8 : un fichier v8 lève ici
 * le message explicite `getDgnV8Message()` (convertisseur externe requis). Sert
 * de repli à `toDxfBuffer` quand aucun `DGN_TO_DXF_BIN` n'est configuré — le DXF
 * produit est ensuite routé vers le pipeline d'ingestion DXF complet.
 *
 * Aucune reprojection (`-t_srs`) : on conserve les coordonnées du dessin telles
 * quelles (cadastre sénégalais = UTM28N mètres), comme le convertisseur externe
 * `convertDgnToDxf` et l'export ODA — le pipeline DXF assigne ensuite EPSG:32628.
 */
export async function convertDgnV7ToDxf(buffer: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "geo-dgn7-"));
  const inputPath = path.join(dir, "input.dgn");
  const outputPath = path.join(dir, "output.dxf");

  try {
    await writeFile(inputPath, buffer);

    // Détection précoce du v8 (message clair plutôt qu'un échec ogr2ogr opaque).
    if (isDgnV8Error(await ogrInfo(inputPath))) {
      throw new Error(getDgnV8Message());
    }

    try {
      await execFileAsync(
        resolveOgr2Ogr(),
        ["-f", "DXF", "-skipfailures", outputPath, inputPath],
        { timeout: 180000, maxBuffer: 1024 * 1024 * 100 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDgnV8Error(msg)) throw new Error(getDgnV8Message());
      throw new Error(`Conversion DGN v7 → DXF (ogr2ogr) échouée : ${msg}`);
    }

    if (!existsSync(outputPath)) {
      throw new Error("ogr2ogr n'a produit aucun DXF depuis le DGN (fichier illisible ?).");
    }
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
