/**
 * sections-from-shapefile.ts — construit des `SectionCandidate` directement
 * depuis un shapefile (.shp + .dbf), sans passer par l'ingestion DXF complète
 * (lecture native + tuilage). Deux types de géométrie source :
 *
 *  - Polygon/MultiPolygon : déjà fermés, utilisés tels quels (juste reprojetés).
 *  - LineString/MultiLineString : limites de section non fermées, comme la
 *    couche `limites_sections` d'un DXF — reconstruites en polygones fermés
 *    via le même moteur de polygonisation (`polygonize.ts`, nodage JSTS +
 *    Polygonizer). Le numéro de section est ici porté PAR CHAQUE LIGNE (champ
 *    du .dbf), pas par un point/label séparé comme en DXF : les lignes sont
 *    donc regroupées par numéro AVANT nodage, chaque groupe étant polygonisé
 *    indépendamment (pas de jointure point-dans-polygone à faire ensuite).
 *
 * Réutilise ensuite `buildLimiteSections` (jointure commune, dissolution,
 * contrôle des chevauchements) exactement comme pour un import DXF — même
 * table, même logique de fusion/résidus.
 */
import * as turf from "@turf/turf";
import crypto from "crypto";
import proj4 from "proj4";
import * as shapefile from "shapefile";
import type { SectionCandidate } from "@/lib/parcelle-ingestion";
import { polygonizeLines } from "@/lib/polygonize";
import { convertGeometryToWgs84 } from "./import-data";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

// Projection UTM Zone 28N (WGS84) — même référentiel planaire que le pipeline
// DXF (polygonize.ts travaille en mètres, EPSG:32628) et que les shapefiles
// cadastraux sénégalais bruts (cf. import-data.ts).
const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

function hashGeom(geom: PolyGeom): string {
  return crypto.createHash("sha256").update(JSON.stringify(geom)).digest("hex");
}

function representativePoint(geom: PolyGeom): [number, number] {
  try {
    return turf.pointOnFeature(turf.feature(geom)).geometry.coordinates as [number, number];
  } catch {
    return turf.centroid(turf.feature(geom)).geometry.coordinates as [number, number];
  }
}

/**
 * Recherche insensible à la casse : les noms de champs .dbf sont écrits tels
 * quels par le logiciel source (Esri tronque/majusculise souvent à 10
 * caractères) — un alias figé (`Num_sectio` vs `NUM_SECTIO` vs `num_sectio`)
 * finit toujours par manquer une variante réelle. On normalise une fois par
 * feature plutôt que d'énumérer indéfiniment des casses.
 */
function propByAlias(props: Record<string, unknown>, ...aliases: string[]): unknown {
  for (const [key, value] of Object.entries(props)) {
    const normalized = key.trim().toLowerCase();
    if (aliases.includes(normalized)) return value;
  }
  return undefined;
}

/**
 * Numéro de section : priorité à la colonne mappée par l'utilisateur
 * (`FieldMappingModal`), repli sur les mêmes alias d'attributs que l'import
 * shapefile du module Cadastre si non mappée ou absente de la feature.
 */
function extractNumSection(props: Record<string, unknown>, mappedColumn?: string): string | null {
  if (mappedColumn) {
    const raw = props[mappedColumn];
    const digits = raw !== undefined && raw !== null ? String(raw).replace(/\D/g, "") : "";
    if (digits.length === 11) return digits.substring(8, 11);
    if (digits) return digits.padStart(3, "0");
  }
  const numSectN = propByAlias(props, "num_sect_n");
  if (numSectN && String(numSectN).replace(/\D/g, "").length === 11) {
    return String(numSectN).replace(/\D/g, "").substring(8, 11);
  }
  const raw = propByAlias(
    props,
    "num_sectio", "num_sect", "numsect", "numsection", "num_section", "section",
  );
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits ? digits.padStart(3, "0") : null;
}

// Même tolérance de raccord que le réseau de sections DXF (plus large que le
// défaut parcelle : les tracés de limites de section comportent plus souvent
// des trous métriques d'accrochage).
const SECTION_SNAP_TOLERANCE_M = Number(process.env.DXF_SECTION_SNAP_TOLERANCE_M || 1);

function toClosedPolyGeom(geometry: GeoJSON.Geometry | null | undefined): PolyGeom | null {
  if (!geometry) return null;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return geometry;
  return null;
}

/** Reprojette un point vers UTM28N s'il est en degrés (heuristique symétrique de `convertGeometryToWgs84`). */
function toUtm28n([x, y]: number[]): number[] {
  if (Math.abs(x) > 180 || Math.abs(y) > 90) return [x, y]; // déjà planaire (UTM ou similaire)
  try {
    return proj4(WGS84, UTM28N, [x, y]);
  } catch {
    return [x, y];
  }
}

/** Extrait les tracés d'une géométrie ligne (coords en mètres, UTM28N). */
function extractLinesUtm(geometry: GeoJSON.Geometry): number[][][] {
  if (geometry.type === "LineString") return [geometry.coordinates.map(toUtm28n)];
  if (geometry.type === "MultiLineString") return geometry.coordinates.map((line) => line.map(toUtm28n));
  return [];
}

function buildCandidateFromPolygon(numSection: string | null, geom: PolyGeom): SectionCandidate {
  let surfaceM2 = 0;
  try {
    surfaceM2 = turf.area(turf.feature(geom));
  } catch {
    /* 0 */
  }
  return {
    numSection,
    geomGeoJson4326: geom,
    repPoint4326: representativePoint(geom),
    surfaceM2,
    geomHash: hashGeom(geom),
  };
}

export interface ShapefileInput {
  name: string;
  buffer: Buffer;
}

/** Lit un shapefile (.shp requis, .dbf pour les attributs) et construit les candidates de section. */
export async function sectionCandidatesFromShapefile(
  files: ShapefileInput[],
  fieldMapping?: { numSection?: string },
): Promise<SectionCandidate[]> {
  const shp = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
  const dbf = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
  if (!shp) throw new Error("Fichier .shp manquant.");

  let source: { features?: GeoJSON.Feature[] };
  try {
    source = await shapefile.read(shp.buffer, dbf?.buffer);
  } catch (err) {
    throw new Error(`Erreur lecture shapefile : ${err instanceof Error ? err.message : String(err)}`);
  }

  const candidates: SectionCandidate[] = [];
  // Lignes de limites (non fermées) regroupées par numéro de section — chaque
  // groupe est nodé/polygonisé indépendamment (le numéro tranche déjà
  // l'appartenance, pas besoin de jointure point-dans-polygone après coup).
  const lineGroups = new Map<string, number[][][]>();
  let nbLignesSansNumero = 0;
  let nbPolygonesSansNumero = 0;

  for (const feature of source.features ?? []) {
    const geomType = feature.geometry?.type;
    if (geomType === "Polygon" || geomType === "MultiPolygon") {
      const geom = toClosedPolyGeom(convertGeometryToWgs84(feature.geometry));
      if (!geom) continue;
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const numSection = extractNumSection(props, fieldMapping?.numSection);
      if (!numSection) {
        if (nbPolygonesSansNumero === 0) {
          console.warn(
            `[sections-from-shapefile] Numéro de section introuvable, champs disponibles : ${Object.keys(props).join(", ") || "(aucun)"}`,
          );
        }
        nbPolygonesSansNumero++;
      }
      candidates.push(buildCandidateFromPolygon(numSection, geom));
      continue;
    }
    if (geomType === "LineString" || geomType === "MultiLineString") {
      const numSection = extractNumSection((feature.properties ?? {}) as Record<string, unknown>, fieldMapping?.numSection);
      if (!numSection) {
        nbLignesSansNumero++;
        continue;
      }
      const lines = extractLinesUtm(feature.geometry!);
      const group = lineGroups.get(numSection);
      if (group) group.push(...lines);
      else lineGroups.set(numSection, lines);
    }
  }
  if (nbLignesSansNumero > 0) {
    console.warn(
      `[sections-from-shapefile] ${nbLignesSansNumero} ligne(s) de limite sans numéro de section ignorée(s).`,
    );
  }
  if (nbPolygonesSansNumero > 0) {
    console.warn(
      `[sections-from-shapefile] ${nbPolygonesSansNumero} polygone(s) sans numéro de section détecté (voir champs listés ci-dessus).`,
    );
  }

  let nbGroupesNonFermes = 0;
  for (const [numSection, lines] of lineGroups) {
    const polygonsUtm = polygonizeLines(lines, { snapToleranceM: SECTION_SNAP_TOLERANCE_M });
    if (polygonsUtm.length === 0) {
      nbGroupesNonFermes++;
      continue;
    }
    for (const polyUtm of polygonsUtm) {
      const geom = toClosedPolyGeom(convertGeometryToWgs84(polyUtm));
      if (!geom) continue;
      candidates.push(buildCandidateFromPolygon(numSection, geom));
    }
  }
  if (nbGroupesNonFermes > 0) {
    console.warn(
      `[sections-from-shapefile] ${nbGroupesNonFermes} numéro(s) de section dont les lignes ne referment aucun polygone.`,
    );
  }

  return candidates;
}
