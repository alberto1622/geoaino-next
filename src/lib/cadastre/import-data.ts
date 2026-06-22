/**
 * Module d'import des données cadastrales (module Cadastre).
 * Traite les shapefiles (.shp + .dbf), GeoJSON et CSV.
 * Porté depuis vericad/server/importData.ts (Drizzle → Prisma).
 */
import { prisma } from "@/lib/prisma";
// @ts-expect-error — shapefile n'a pas de types complets
import * as shapefile from "shapefile";
import proj4 from "proj4";

// Projection UTM Zone 28N (WGS84) — utilisée par les shapefiles cadastraux sénégalais
const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

function utmToWgs84(x: number, y: number): [number, number] {
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return [x, y];
  try {
    const [lon, lat] = proj4(UTM28N, WGS84, [x, y]);
    return [lon, lat];
  } catch {
    return [x, y];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertGeometryToWgs84(geometry: any): any {
  if (!geometry) return geometry;
  const needsConversion = (coords: number[]): boolean =>
    Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90;
  const convertCoord = (c: number[]): number[] => {
    if (c.length >= 2 && needsConversion(c)) {
      const [lon, lat] = utmToWgs84(c[0], c[1]);
      return c.length > 2 ? [lon, lat, c[2]] : [lon, lat];
    }
    return c;
  };
  const convertRing = (ring: number[][]): number[][] => ring.map(convertCoord);
  try {
    if (geometry.type === "Point") return { ...geometry, coordinates: convertCoord(geometry.coordinates) };
    if (geometry.type === "LineString") return { ...geometry, coordinates: convertRing(geometry.coordinates) };
    if (geometry.type === "Polygon") return { ...geometry, coordinates: geometry.coordinates.map(convertRing) };
    if (geometry.type === "MultiPolygon")
      return { ...geometry, coordinates: geometry.coordinates.map((poly: number[][][]) => poly.map(convertRing)) };
    if (geometry.type === "MultiLineString") return { ...geometry, coordinates: geometry.coordinates.map(convertRing) };
  } catch {
    return geometry;
  }
  return geometry;
}

export interface FichierInput {
  nom: string;
  contenu: string; // base64
}

export interface ImportResult {
  nbImportes: number;
  nbIgnores?: number;
  nbErreurs?: number;
  warnings?: string[];
}

function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}
function base64ToString(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf-8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseShapefile(fichiers: FichierInput[]): Promise<any | null> {
  const shpFile = fichiers.find((f) => f.nom.toLowerCase().endsWith(".shp"));
  const dbfFile = fichiers.find((f) => f.nom.toLowerCase().endsWith(".dbf"));
  if (!shpFile) return null;
  const shpBuf = base64ToBuffer(shpFile.contenu);
  const dbfBuf = dbfFile ? base64ToBuffer(dbfFile.contenu) : undefined;
  try {
    return await shapefile.read(shpBuf, dbfBuf);
  } catch (err) {
    throw new Error(`Erreur lecture shapefile : ${err instanceof Error ? err.message : String(err)}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGeoJSON(fichiers: FichierInput[]): any | null {
  const geojsonFile = fichiers.find(
    (f) => f.nom.toLowerCase().endsWith(".geojson") || f.nom.toLowerCase().endsWith(".json"),
  );
  if (geojsonFile) {
    try {
      return JSON.parse(base64ToString(geojsonFile.contenu));
    } catch {
      return null;
    }
  }
  return null;
}

function parseCSV(fichiers: FichierInput[]): Record<string, string>[] | null {
  const csvFile = fichiers.find((f) => f.nom.toLowerCase().endsWith(".csv"));
  if (!csvFile) return null;
  const text = base64ToString(csvFile.contenu);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const firstLine = lines[0];
  const sep = firstLine.includes(";") ? ";" : firstLine.includes("\t") ? "\t" : ",";
  const headers = firstLine.split(sep).map((h) => h.trim().replace(/^["']|["']$/g, ""));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(sep).map((v) => v.trim().replace(/^["']|["']$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveGeoJSON(fichiers: FichierInput[]): Promise<any | null> {
  const shpFile = fichiers.find((f) => f.nom.toLowerCase().endsWith(".shp"));
  if (shpFile) return await parseShapefile(fichiers);
  const gj = parseGeoJSON(fichiers);
  if (gj) return gj;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractGeometry(feature: any): string | null {
  if (!feature?.geometry) return null;
  try {
    return JSON.stringify(feature.geometry);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function approximateCentroid(geometry: any): { lon: number; lat: number } | null {
  try {
    if (geometry.type === "Point") return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
    if (geometry.type === "Polygon" && geometry.coordinates[0]) {
      const ring = geometry.coordinates[0];
      const lon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length;
      const lat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length;
      return { lon, lat };
    }
    if (geometry.type === "MultiPolygon" && geometry.coordinates[0]?.[0]) {
      const ring = geometry.coordinates[0][0];
      const lon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length;
      const lat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length;
      return { lon, lat };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeSyscol(syscol: string | number | undefined): string {
  if (!syscol) return "";
  return String(syscol).replace(/\D/g, "").padStart(8, "0");
}

// ─── Import Communes 2013 ─────────────────────────────────────────────────────
export async function importCommunes2013(fichiers: FichierInput[]): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;

  const geojson = await resolveGeoJSON(fichiers);
  if (geojson) {
    const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
    for (const feature of features) {
      try {
        const props = feature.properties ?? {};
        const syscolRaw =
          props.Syscol ?? props.SYSCOL ?? props.syscol ?? props.COD_SYSCOL ?? props.cod_syscol ?? "";
        const nomCommune =
          props.NomCommune ?? props.NOM_COMMUN ?? props.NOM ?? props.nom ?? props.Commune ?? props.COMMUNE ?? "";
        if (!syscolRaw) {
          nbIgnores++;
          continue;
        }
        const syscolPadded = normalizeSyscol(syscolRaw);
        const geomStr = extractGeometry(feature);
        const existing = await prisma.cadCommune2013.findFirst({
          where: { syscolPadded },
          select: { id: true },
        });
        if (existing) {
          await prisma.cadCommune2013.update({
            where: { id: existing.id },
            data: { nomCommune: nomCommune || undefined, geojson: geomStr ?? undefined },
          });
        } else {
          await prisma.cadCommune2013.create({
            data: {
              syscol: String(syscolRaw),
              syscolPadded,
              nomCommune: nomCommune || `Commune ${syscolPadded}`,
              geojson: geomStr ?? undefined,
            },
          });
        }
        nbImportes++;
      } catch (err) {
        nbErreurs++;
        if (nbErreurs <= 5) warnings.push(`Erreur feature: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { nbImportes, nbIgnores, nbErreurs, warnings };
  }

  const csvRows = parseCSV(fichiers);
  if (csvRows) {
    for (const row of csvRows) {
      try {
        const syscolRaw = row.Syscol ?? row.SYSCOL ?? row.syscol ?? row.COD_SYSCOL ?? "";
        const nomCommune = row.NomCommune ?? row.NOM_COMMUN ?? row.NOM ?? row.nom ?? row.Commune ?? "";
        if (!syscolRaw) {
          nbIgnores++;
          continue;
        }
        const syscolPadded = normalizeSyscol(syscolRaw);
        const existing = await prisma.cadCommune2013.findFirst({
          where: { syscolPadded },
          select: { id: true },
        });
        if (!existing) {
          await prisma.cadCommune2013.create({
            data: { syscol: syscolRaw, syscolPadded, nomCommune: nomCommune || `Commune ${syscolPadded}` },
          });
          nbImportes++;
        } else {
          nbIgnores++;
        }
      } catch {
        nbErreurs++;
      }
    }
    return { nbImportes, nbIgnores, nbErreurs, warnings };
  }

  throw new Error(
    "Format de fichier non reconnu. Fournissez un shapefile (.shp + .dbf), un fichier GeoJSON (.geojson) ou CSV (.csv)",
  );
}

// ─── Import Communes 2026 ─────────────────────────────────────────────────────
export async function importCommunes2026(fichiers: FichierInput[]): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;

  const geojson = await resolveGeoJSON(fichiers);
  if (geojson) {
    const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
    for (const feature of features) {
      try {
        const props = feature.properties ?? {};
        const syscolRaw =
          props.COD_SYSCOL ?? props.Syscol ?? props.SYSCOL ?? props.syscol ?? props.cod_syscol ?? "";
        const nomCommune =
          props.NomCommune ?? props.NOM_COMMUN ?? props.NOM ?? props.nom ?? props.Commune ?? props.COMMUNE ?? "";
        const region = props.REGION ?? props.Region ?? props.region ?? props.NOM_REGION ?? "";
        const departement = props.DEPARTEMEN ?? props.DEPARTEMENT ?? props.Departement ?? props.departement ?? "";
        if (!syscolRaw) {
          nbIgnores++;
          continue;
        }
        const syscolPadded = normalizeSyscol(syscolRaw);
        const geomStr = extractGeometry(feature);
        const existing = await prisma.cadCommune2026.findFirst({
          where: { syscolPadded },
          select: { id: true },
        });
        if (existing) {
          await prisma.cadCommune2026.update({
            where: { id: existing.id },
            data: {
              nomCommune: nomCommune || undefined,
              region: region || undefined,
              departement: departement || undefined,
              geojson: geomStr ?? undefined,
            },
          });
        } else {
          await prisma.cadCommune2026.create({
            data: {
              codSyscol: String(syscolRaw),
              syscolPadded,
              nomCommune: nomCommune || `Commune ${syscolPadded}`,
              region: region || undefined,
              departement: departement || undefined,
              geojson: geomStr ?? undefined,
            },
          });
        }
        nbImportes++;
      } catch (err) {
        nbErreurs++;
        if (nbErreurs <= 5) warnings.push(`Erreur feature: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { nbImportes, nbIgnores, nbErreurs, warnings };
  }

  const csvRows = parseCSV(fichiers);
  if (csvRows) {
    for (const row of csvRows) {
      try {
        const syscolRaw = row.COD_SYSCOL ?? row.Syscol ?? row.SYSCOL ?? row.syscol ?? "";
        const nomCommune = row.NomCommune ?? row.NOM_COMMUN ?? row.NOM ?? row.nom ?? row.Commune ?? "";
        const region = row.REGION ?? row.Region ?? row.region ?? "";
        const departement = row.DEPARTEMEN ?? row.DEPARTEMENT ?? row.departement ?? "";
        if (!syscolRaw) {
          nbIgnores++;
          continue;
        }
        const syscolPadded = normalizeSyscol(syscolRaw);
        const existing = await prisma.cadCommune2026.findFirst({
          where: { syscolPadded },
          select: { id: true },
        });
        if (!existing) {
          await prisma.cadCommune2026.create({
            data: {
              codSyscol: syscolRaw,
              syscolPadded,
              nomCommune: nomCommune || `Commune ${syscolPadded}`,
              region: region || undefined,
              departement: departement || undefined,
            },
          });
          nbImportes++;
        } else {
          nbIgnores++;
        }
      } catch {
        nbErreurs++;
      }
    }
    return { nbImportes, nbIgnores, nbErreurs, warnings };
  }

  throw new Error(
    "Format de fichier non reconnu. Fournissez un shapefile (.shp + .dbf), un fichier GeoJSON (.geojson) ou CSV (.csv)",
  );
}

// ─── Import Sections ──────────────────────────────────────────────────────────
export async function importSections(fichiers: FichierInput[]): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;

  const geojson = await resolveGeoJSON(fichiers);
  if (!geojson) {
    throw new Error("Format non reconnu. Fournissez un shapefile (.shp + .dbf) ou GeoJSON (.geojson)");
  }
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];

  for (const feature of features) {
    try {
      const props = feature.properties ?? {};
      const numSectN = props.Num_sect_N ?? props.NUM_SECT_N ?? "";
      const numSectioRaw =
        props.Num_sectio ?? props.Num_sect ?? props.NUM_SECT ?? props.NUMSECT ?? props.numSection ?? props.NUM_SECTION ?? props.SECTION ?? "";
      const nomSection = props.NOM_SECT ?? props.NOMSECT ?? props.nomSection ?? props.NOM_SECTION ?? props.NAME ?? "";
      const nomCommune = props.COM_ARROND ?? props.NomCommune ?? props.NOM_COMMUN ?? props.NOM ?? props.nom ?? "";
      const region = props.REGION ?? props.region ?? "";
      const departement = props.ARRONDISSE ?? props.DEPARTEMENT ?? props.departement ?? "";

      let syscolPadded = "";
      let numSectionPadded = "";
      if (numSectN && String(numSectN).replace(/\D/g, "").length === 11) {
        const code11 = String(numSectN).replace(/\D/g, "");
        syscolPadded = code11.substring(0, 8);
        numSectionPadded = code11.substring(8, 11);
      } else {
        const syscolRaw = props.COD_SYSCOL ?? props.Syscol ?? props.SYSCOL ?? props.syscol ?? props.COMMUNE_SYS ?? "";
        if (!syscolRaw || !numSectioRaw) {
          nbIgnores++;
          continue;
        }
        syscolPadded = normalizeSyscol(syscolRaw);
        numSectionPadded = String(numSectioRaw).replace(/\D/g, "").padStart(3, "0");
      }
      if (!syscolPadded || !numSectionPadded) {
        nbIgnores++;
        continue;
      }
      const geomStr = extractGeometry(feature);
      const existingSection = await prisma.cadSection.findFirst({
        where: { syscolCommune: syscolPadded, numSection: numSectionPadded },
        select: { id: true },
      });
      if (existingSection) {
        await prisma.cadSection.update({
          where: { id: existingSection.id },
          data: {
            nomSection: nomSection || undefined,
            nomCommune: nomCommune || undefined,
            geojson: geomStr ?? undefined,
          },
        });
      } else {
        await prisma.cadSection.create({
          data: {
            syscolCommune: syscolPadded,
            numSection: numSectionPadded,
            nomSection: nomSection || undefined,
            nomCommune: nomCommune || undefined,
            region: region || undefined,
            departement: departement || undefined,
            version: "2013",
            geojson: geomStr ?? undefined,
          },
        });
      }
      nbImportes++;
    } catch (err) {
      nbErreurs++;
      if (nbErreurs <= 5) warnings.push(`Erreur feature: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { nbImportes, nbIgnores, nbErreurs, warnings };
}

// ─── Import Parcelles ─────────────────────────────────────────────────────────
export async function importParcelles(fichiers: FichierInput[]): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;

  const geojson = await resolveGeoJSON(fichiers);
  if (!geojson) {
    throw new Error("Format non reconnu. Fournissez un shapefile (.shp + .dbf) ou GeoJSON (.geojson)");
  }
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    try {
      const props = feature.properties ?? {};
      const nicadRaw = String(props.nicad ?? props.NICAD ?? "").replace(/\D/g, "");
      const codesectio = String(props.Codesectio ?? props.CODESECTIO ?? props.COD_SECT ?? "").replace(/\D/g, "");
      const numParcelleRaw = props.numParcell ?? props.NUM_PARCE ?? props.NUMPARCE ?? props.numParcelle ?? "";

      let syscolPadded = "";
      let numSectionPadded = "";
      let numParcellePadded = "";
      let nicadCode = "";

      if (nicadRaw.length === 16) {
        syscolPadded = nicadRaw.substring(0, 8);
        numSectionPadded = nicadRaw.substring(8, 11);
        numParcellePadded = nicadRaw.substring(11, 16);
        nicadCode = nicadRaw;
      } else if (codesectio.length === 11) {
        syscolPadded = codesectio.substring(0, 8);
        numSectionPadded = codesectio.substring(8, 11);
        numParcellePadded = numParcelleRaw
          ? String(numParcelleRaw).replace(/\D/g, "").padStart(5, "0")
          : String(i + 1).padStart(5, "0");
      } else {
        const syscolRaw = props.COD_SYSCOL ?? props.Syscol ?? props.SYSCOL ?? props.syscol ?? props.COMMUNE_SYS ?? "";
        if (!syscolRaw) {
          nbIgnores++;
          continue;
        }
        syscolPadded = normalizeSyscol(syscolRaw);
        const numSectionRaw = props.NUM_SECT ?? props.NUMSECT ?? props.numSection ?? props.NUM_SECTION ?? "";
        numSectionPadded = numSectionRaw ? String(numSectionRaw).replace(/\D/g, "").padStart(3, "0") : "001";
        numParcellePadded = numParcelleRaw
          ? String(numParcelleRaw).replace(/\D/g, "").padStart(5, "0")
          : String(i + 1).padStart(5, "0");
      }
      if (!syscolPadded || !numSectionPadded || !numParcellePadded) {
        nbIgnores++;
        continue;
      }

      const nomCommune = props.commune ?? props.NomCommune ?? props.NOM_COMMUN ?? props.NOM ?? "";
      const region = props.region ?? props.REGION ?? "";
      const departement = props.departemen ?? props.DEPARTEMENT ?? props.departement ?? "";
      const quartier = props.Quartier ?? props.QUARTIER ?? props.quartier ?? props.NOM_QUART ?? "";
      const numLot = props.NumLot ?? props.NUM_LOT ?? props.NUMLOT ?? props.numLot ?? "";
      const titreParce = props.TitreParce ?? props.TITRE_PARC ?? props.TITREPARCE ?? props.titreParce ?? "";
      const typeDocFon = props.TypeDocFon ?? props.TYPE_DOC ?? props.TYPEDOC ?? props.typeDocFon ?? "";
      const natJuri = props.NatJuri ?? props.NAT_JURI ?? props.NATJURI ?? props.natJuri ?? "";
      const typeDestin = props.TypeDestin ?? props.TYPE_DEST ?? props.TYPEDEST ?? props.typeDestin ?? "";
      const catOcup = props.CatOcup ?? props.CAT_OCUP ?? props.CATOCUP ?? props.catOcup ?? "";
      const superficie = props.SupLegale ?? props.SupReelle ?? props.SUPERFICIE ?? props.superficie ?? props.Shape_Area ?? "";
      const nomProprietaire = props.TitulaireD ?? props.Occupant ?? props.nomProprietaire ?? "";

      const geomConverted = feature.geometry ? convertGeometryToWgs84(feature.geometry) : null;
      const geomStr = geomConverted ? JSON.stringify(geomConverted) : null;
      const centroid = geomConverted ? approximateCentroid(geomConverted) : null;
      const superficieNum = superficie ? parseFloat(String(superficie)) : undefined;

      await prisma.cadParcelle.create({
        data: {
          syscolCommune: syscolPadded,
          numSection: numSectionPadded,
          numParcelle: numParcellePadded,
          version: "2013",
          statut: nicadCode ? "actif" : "sans_nicad",
          nicad: nicadCode || undefined,
          nomCommune: nomCommune || undefined,
          region: region || undefined,
          departement: departement || undefined,
          quartier: quartier || undefined,
          numLot: numLot || undefined,
          titreParce: titreParce || undefined,
          typeDocFon: typeDocFon || undefined,
          natJuri: natJuri || undefined,
          typeDestin: typeDestin || undefined,
          catOcup: catOcup || undefined,
          nomProprietaire: nomProprietaire || undefined,
          superficie: superficieNum && !isNaN(superficieNum) ? superficieNum : undefined,
          geojson: geomStr ?? undefined,
          longitude: centroid ? centroid.lon : undefined,
          latitude: centroid ? centroid.lat : undefined,
        },
      });
      nbImportes++;
    } catch (err) {
      nbErreurs++;
      if (nbErreurs <= 5) warnings.push(`Erreur feature ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { nbImportes, nbIgnores, nbErreurs, warnings };
}

// ─── Import NICAD ─────────────────────────────────────────────────────────────
export async function importNicads(fichiers: FichierInput[], userId?: string): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;

  const csvRows = parseCSV(fichiers);
  if (!csvRows) {
    throw new Error("Format non reconnu. Fournissez un fichier CSV avec les colonnes NICAD, SYSCOL, etc.");
  }
  for (const row of csvRows) {
    try {
      const nicadCode = (row.NICAD ?? row.nicad ?? row.NIC_AD ?? "").replace(/\s/g, "");
      if (!nicadCode || nicadCode.length !== 16) {
        nbIgnores++;
        continue;
      }
      const existing = await prisma.cadNicad.findUnique({ where: { nicad: nicadCode }, select: { id: true } });
      if (existing) {
        nbIgnores++;
        continue;
      }
      const syscol = nicadCode.substring(0, 8);
      const numParcelle = nicadCode.substring(8, 16);
      const version = (row.VERSION ?? row.version ?? "2013") as "2013" | "2026";
      await prisma.cadNicad.create({
        data: {
          nicad: nicadCode,
          syscol,
          numParcelle,
          version,
          statut: "actif",
          nomCommune: row.COMMUNE ?? row.commune ?? row.NOM_COMMUN ?? undefined,
          region: row.REGION ?? row.region ?? undefined,
          departement: row.DEPARTEMENT ?? row.departement ?? undefined,
          createdBy: userId,
        },
      });
      nbImportes++;
    } catch (err) {
      nbErreurs++;
      if (nbErreurs <= 5) warnings.push(`Erreur ligne: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { nbImportes, nbIgnores, nbErreurs, warnings };
}

// ─── Export des données (CSV / JSON) ──────────────────────────────────────────
export interface ExportParams {
  typeExport: "nicads" | "historique" | "communes2013" | "communes2026";
  format: "csv" | "json";
  filtreVersion?: "2013" | "2026";
  filtreStatut?: "actif" | "bascule" | "invalide";
  includeGeom?: boolean;
}

export interface ExportResult {
  nbEntites: number;
  contenu: string;
}

export async function exportData(params: ExportParams): Promise<ExportResult> {
  const { plain } = await import("./serialize");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[] = [];

  if (params.typeExport === "nicads") {
    rows = plain(
      await prisma.cadNicad.findMany({
        where: {
          ...(params.filtreVersion ? { version: params.filtreVersion } : {}),
          ...(params.filtreStatut ? { statut: params.filtreStatut } : {}),
        },
      }),
    );
  } else if (params.typeExport === "historique") {
    rows = plain(await prisma.cadNicadHistorique.findMany({ orderBy: { createdAt: "desc" } }));
  } else if (params.typeExport === "communes2013") {
    const allRows = plain(await prisma.cadCommune2013.findMany());
    rows = params.includeGeom ? allRows : allRows.map(({ geojson, ...rest }) => rest);
  } else if (params.typeExport === "communes2026") {
    const allRows = plain(await prisma.cadCommune2026.findMany());
    rows = params.includeGeom ? allRows : allRows.map(({ geojson, ...rest }) => rest);
  }

  let contenu = "";
  if (params.format === "json") {
    contenu = JSON.stringify(rows, null, 2);
  } else if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    const csvLines = [
      headers.join(";"),
      ...rows.map((row) =>
        headers
          .map((h) => {
            const val = row[h];
            if (val === null || val === undefined) return "";
            const str = String(val);
            return str.includes(";") || str.includes('"') || str.includes("\n")
              ? `"${str.replace(/"/g, '""')}"`
              : str;
          })
          .join(";"),
      ),
    ];
    contenu = csvLines.join("\n");
  }

  return { nbEntites: rows.length, contenu };
}
