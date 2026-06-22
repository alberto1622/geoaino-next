/**
 * parcelle-ingestion.ts
 *
 * Pipeline DXF (ACAD, issu d'ODA File Converter à partir d'un DGN V8
 * Microstation) → parcelles cadastrales exploitables, en s'appuyant sur la
 * nomenclature officielle DGID ("Etapes de travail sur Microstation.md") déjà
 * implémentée dans `cadastral-filter.ts` (`filterDxfCadastralFeatures`,
 * `_dgid_layer_class`).
 *
 * Étapes :
 * 1. Conversion DXF → GeoJSON via ogr2ogr, géométrie assignée en EPSG:32628
 *    (UTM zone 28N, Sénégal) sans transformation — le DXF est déjà en mètres.
 * 2. Classification des entités par calque DGID via `filterDxfCadastralFeatures`
 *    (`limites_parcelles`/`limites_tf` = limites de parcelle, `limites_sections`
 *    = couche-support de section, `piscine` = emprise de piscine, `batiment` =
 *    exclu, `numero_parcelle`/`numero_tf` = numéro, `numero_lot` = lot,
 *    `proprietaire` = propriétaire, `titre_parcelle` = dénomination,
 *    `numero_section` = numéro de section, `numero_batiment`/`nb_nv_bati` =
 *    autres textes). Les annotations MTEXT multi-lignes (étape 5) sont éclatées
 *    ligne par ligne avant classification.
 * 3. Jointures spatiales point-dans-polygone (index en grille type STRtree) :
 *    textes → parcelle (numéro/lot/propriétaire/dénomination), parcelle →
 *    section (numero_section), piscine → parcelle (is_piscine, piscine_surface).
 *    Le calque du texte prime sur l'heuristique. Le numero_parcelle est
 *    normalisé à 5 chiffres pour construire le NICAD (16 caractères, cf. nicad.ts).
 * 4. Validation géométrique (anneaux fermés, aire planaire > 0, validité
 *    topologique, plausibilité de l'emprise UTM28N) et reprojection
 *    EPSG:32628 → EPSG:4326. Détection de doublons et chevauchements
 *    (étape 10 : erreurs de topologie).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import proj4 from "proj4";
import * as turf from "@turf/turf";
import { resolveOgr2Ogr } from "./dgn-parser";
import {
  filterDxfCadastralFeatures,
  normalizeFeatureCollection,
  type FeatureCollection as DgidFeatureCollection,
  type GeoFeature as DgidGeoFeature,
} from "./cadastral-filter";
import { normalizeNumeroParcelle, normalizeSection } from "./nicad";
import { readDxfWorldFeatures } from "./dxf-native";
import { polygonizeLines } from "./polygonize";

const execFileAsync = promisify(execFile);

// UTM zone 28N (Sénégal) — coordonnées en mètres.
proj4.defs("EPSG:32628", "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs");

export interface ParcelleCandidate {
  numero: string | null;
  /** Numéro de parcelle normalisé à 5 chiffres (sert à construire le NICAD). */
  numeroParcelle5: string | null;
  numeroLot: string | null;
  /** Numéro de section (3 chiffres) issu de la jointure parcelle ∈ limites_sections. */
  numeroSection: string | null;
  /**
   * NICAD 16 caractères. `null` tant que le Syscol n'est pas résolu : il est
   * construit par jointure spatiale sur `cad_communes_2026` (cf.
   * `assign-nicad-2026.ts`), le DXF ne portant pas le préfixe territorial.
   */
  nicad: string | null;
  /** Syscol 2026 (8 chiffres) de la commune contenant la parcelle (rempli après jointure). */
  syscolCommune2026: string | null;
  /** Nom de la commune 2026 contenant la parcelle (rempli après jointure). */
  nomCommune2026: string | null;
  /** Point représentatif intérieur (EPSG:4326, [lng, lat]) pour la jointure commune. */
  repPoint4326: [number, number];
  proprietaire: string | null;
  denomination: string | null;
  autresTextes: string[];
  isPiscine: boolean;
  piscineSurfaceM2: number;
  surfaceM2: number;
  geomWkt32628: string;
  geomGeoJson4326: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  geomHash: string;
}

export interface DxfIngestionReport {
  nbParcelles: number;
  nbSansNumero: number;
  nbSansDenomination: number;
  nbSansProprietaire: number;
  nbSansSection: number;
  /** Parcelles dont aucune commune 2026 n'a pu être résolue (NICAD non construit). */
  nbSansCommune2026: number;
  /** Parcelles rattachées à une commune 2026 par proximité (hors contenance stricte). */
  nbCommune2026Approx: number;
  nbNumeroNonConforme: number;
  nbPiscines: number;
  nbParcellesPolygonisees: number;
  nbPolygonesEnveloppeIgnores: number;
  nbHorsEmprise: number;
  nbPolylignesOuvertesIgnorees: number;
  nbTextesHorsParcelle: number;
  nbPolygonesInvalidesRejetes: number;
  nbAutresCouchesIgnorees: number;
  nbDoublonsGeometrie: number;
  nbChevauchements: number;
  surfaceTotaleM2: number;
  surfacePiscinesM2: number;
  warnings: string[];
}

export interface DxfIngestionResult {
  parcelles: ParcelleCandidate[];
  report: DxfIngestionReport;
}

type Ring = number[][];
type PolygonGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

const CLOSE_EPSILON = 1e-6;

// Tolérance (mètres, EPSG:32628) pour fermer une polyligne *quasi* fermée :
// les LWPOLYLINE de limites de parcelle visuellement fermées mais sans
// indicateur "closed" sortent en LineString avec un écart d'arrondi de
// quelques cm entre le premier et le dernier point. On les raccorde, sans
// fermer de force les polylignes réellement ouvertes (segments isolés).
const CLOSE_SNAP_TOLERANCE_M = Number(process.env.DXF_CLOSE_SNAP_TOLERANCE_M || 0.05);

// Polygonisation des limites dessinées en segments séparés (cf. polygonize.ts).
// Aire mini : élimine les slivers. Aire maxi : élimine l'anneau enveloppe
// global produit par la polygonisation (la zone entière du lotissement).
const POLYGONIZE_MIN_AREA_M2 = Number(process.env.DXF_POLYGONIZE_MIN_AREA_M2 || 5);
const POLYGONIZE_MAX_AREA_M2 = Number(process.env.DXF_POLYGONIZE_MAX_AREA_M2 || 50000);

// ───────────────────────────── Conversion DXF ─────────────────────────────

function sanitizeFileName(fileName: string): string {
  return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Convertit un DXF en FeatureCollection GeoJSON dont les coordonnées sont
 * assignées au CRS EPSG:32628 (aucune transformation : le DXF ODA est déjà
 * en mètres UTM28N).
 */
export async function convertDxfToFc32628(
  buffer: Buffer,
  fileName: string
): Promise<GeoJSON.FeatureCollection> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parcelle-dxf-"));
  const inputPath = path.join(tmpDir, sanitizeFileName(fileName));
  const outputPath = path.join(tmpDir, "output.geojson");

  try {
    fs.writeFileSync(inputPath, buffer);

    const args = [
      "-f", "GeoJSON",
      "-skipfailures",
      "-explodecollections",
      "-nlt", "PROMOTE_TO_MULTI",
      // Le DXF ne porte aucun CRS : on assigne EPSG:32628 sans transformer
      // (les coordonnées sont déjà en mètres UTM zone 28N).
      "-a_srs", "EPSG:32628",
      // Les LWPOLYLINE fermées deviennent des Polygon plutôt que des LineString.
      "-oo", "CLOSED_LINE_AS_POLYGON=YES",
      outputPath,
      inputPath,
    ];

    await execFileAsync(resolveOgr2Ogr(), args, {
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 100,
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error("ogr2ogr n'a produit aucune sortie pour ce DXF.");
    }

    const text = fs.readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(text);
    if (parsed?.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
      throw new Error("Sortie ogr2ogr invalide : FeatureCollection attendue.");
    }
    return parsed as GeoJSON.FeatureCollection;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ───────────────────────────── Géométrie ─────────────────────────────

function almostEqual(a: number, b: number, eps = CLOSE_EPSILON): boolean {
  return Math.abs(a - b) <= eps;
}

function isClosedRing(ring: Ring): boolean {
  if (ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return almostEqual(first[0], last[0]) && almostEqual(first[1], last[1]);
}

/**
 * Tente de transformer une LineString en anneau de polygone fermé.
 * Ferme les polylignes déjà fermées (exact) ou *quasi* fermées (écart ≤
 * `CLOSE_SNAP_TOLERANCE_M`, en raccordant le dernier point au premier).
 * Retourne `null` pour une polyligne réellement ouverte (segments séparés).
 */
function lineStringToClosedRing(coords: unknown): Ring | null {
  if (!Array.isArray(coords) || coords.length < 4) return null;
  const ring = coords as Ring;
  if (isClosedRing(ring)) return ring;

  const first = ring[0];
  const last = ring[ring.length - 1];
  const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
  if (gap <= CLOSE_SNAP_TOLERANCE_M) {
    // Raccorde explicitement le dernier point au premier (anneau fermé).
    return [...ring.slice(0, -1), [first[0], first[1]]];
  }
  return null;
}

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Aire planaire (m²) — valide car les coordonnées sont en mètres (EPSG:32628). */
function geometryAreaM2(geom: PolygonGeom): number {
  const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let total = 0;
  for (const rings of polygons) {
    if (rings.length === 0) continue;
    let area = ringArea(rings[0]);
    for (let i = 1; i < rings.length; i++) area -= ringArea(rings[i]);
    total += Math.max(area, 0);
  }
  return total;
}

function ringToWkt(ring: Ring): string {
  return "(" + ring.map(([x, y]) => `${x} ${y}`).join(",") + ")";
}

function polygonCoordsToWkt(coords: Ring[]): string {
  return "(" + coords.map(ringToWkt).join(",") + ")";
}

export function geometryToWkt32628(geom: PolygonGeom): string {
  if (geom.type === "Polygon") return `POLYGON${polygonCoordsToWkt(geom.coordinates)}`;
  return `MULTIPOLYGON(${geom.coordinates.map(polygonCoordsToWkt).join(",")})`;
}

function reprojectRing(ring: Ring): Ring {
  return ring.map(([x, y]) => proj4("EPSG:32628", "EPSG:4326", [x, y]));
}

function reprojectTo4326(geom: PolygonGeom): PolygonGeom {
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map(reprojectRing) };
  }
  return {
    type: "MultiPolygon",
    coordinates: geom.coordinates.map((poly) => poly.map(reprojectRing)),
  };
}

/** Empreinte stable de la géométrie (mm près) — clé de repli si `numero` est absent. */
function hashGeometry(geom: PolygonGeom): string {
  const rounded =
    geom.type === "Polygon"
      ? geom.coordinates.map((r) => r.map(([x, y]) => [Math.round(x * 1000), Math.round(y * 1000)]))
      : geom.coordinates.map((p) => p.map((r) => r.map(([x, y]) => [Math.round(x * 1000), Math.round(y * 1000)])));
  return crypto.createHash("sha256").update(JSON.stringify(rounded)).digest("hex");
}

// ───────────────────────────── Index spatial (grille) ─────────────────────────────

type BBox = [number, number, number, number];

function geometryBBox(geom: PolygonGeom): BBox {
  return turf.bbox(geom) as BBox;
}

/**
 * Index spatial en grille (équivalent léger d'un STRtree) pour limiter le
 * nombre de tests point-dans-polygone lors de la jointure spatiale.
 */
class BBoxGridIndex {
  private cells = new Map<string, number[]>();
  private cellSize: number;
  private minX: number;
  private minY: number;

  constructor(bboxes: BBox[], targetCellsPerAxis = 32) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [bx0, by0, bx1, by1] of bboxes) {
      minX = Math.min(minX, bx0);
      minY = Math.min(minY, by0);
      maxX = Math.max(maxX, bx1);
      maxY = Math.max(maxY, by1);
    }
    if (!Number.isFinite(minX)) {
      minX = 0; minY = 0; maxX = 1; maxY = 1;
    }
    this.minX = minX;
    this.minY = minY;
    const width = Math.max(maxX - minX, 1e-6);
    const height = Math.max(maxY - minY, 1e-6);
    this.cellSize = Math.max(width, height) / targetCellsPerAxis;

    bboxes.forEach((bbox, idx) => {
      for (const key of this.cellsForBBox(bbox)) {
        const arr = this.cells.get(key);
        if (arr) arr.push(idx);
        else this.cells.set(key, [idx]);
      }
    });
  }

  private cellIndex(x: number, y: number): [number, number] {
    return [Math.floor((x - this.minX) / this.cellSize), Math.floor((y - this.minY) / this.cellSize)];
  }

  private cellsForBBox([bx0, by0, bx1, by1]: BBox): string[] {
    const [cx0, cy0] = this.cellIndex(bx0, by0);
    const [cx1, cy1] = this.cellIndex(bx1, by1);
    const keys: string[] = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) keys.push(`${cx}_${cy}`);
    }
    return keys;
  }

  query(point: [number, number]): number[] {
    const [cx, cy] = this.cellIndex(point[0], point[1]);
    return this.cells.get(`${cx}_${cy}`) ?? [];
  }

  /** Tous les indices dont la cellule intersecte la bbox donnée (sans doublons). */
  queryRange(bbox: BBox): number[] {
    const found = new Set<number>();
    for (const key of this.cellsForBBox(bbox)) {
      const arr = this.cells.get(key);
      if (arr) for (const idx of arr) found.add(idx);
    }
    return Array.from(found);
  }
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// ───────────────────────────── Nomenclature des calques (DGID) ─────────────────────────────
//
// `filterDxfCadastralFeatures` (cadastral-filter.ts) classe déjà chaque
// entité selon la nomenclature officielle (étape 4 : tableau de
// dénominations) et attache `_dgid_layer_class`. On regroupe ici ces
// classes par usage pour la jointure spatiale parcelle ⇄ étiquettes.

/** Calques de limites assimilables à une parcelle (Titre Foncier inclus). */
const PARCEL_BOUNDARY_CLASSES = new Set(["limites_parcelles", "limites_tf"]);

/** Calque de limites de section : couche-support pour la jointure parcelle ∈ section. */
const SECTION_BOUNDARY_CLASS = "limites_sections";

/** Calque d'emprises de piscines : surface rattachée à la parcelle contenante. */
const PISCINE_CLASS = "piscine";

/** Calques de limites d'un autre type d'objet : ni parcelle, ni section, ni piscine. */
const IGNORED_BOUNDARY_CLASSES = new Set(["batiment"]);

/** Calques d'annotation portant le "numéro" de la parcelle (→ NICAD). */
const NUMERO_PARCELLE_CLASSES = new Set(["numero_parcelle", "numero_tf"]);

/** Calques d'annotation portant le numéro de lot. */
const NUMERO_LOT_CLASSES = new Set(["numero_lot"]);

/** Calques d'annotation portant le propriétaire de la parcelle. */
const PROPRIETAIRE_CLASSES = new Set(["proprietaire"]);

/** Calque d'annotation portant le numéro de section (texte placé dans la section). */
const SECTION_NUMERO_CLASS = "numero_section";

/** Calques d'annotation portant la "dénomination" (titre issu du bornage). */
const DENOMINATION_CLASSES = new Set(["titre_parcelle"]);

/** Calques d'annotation à conserver tels quels dans `autres_textes`. */
const OTHER_TEXT_CLASSES = new Set(["numero_batiment", "nb_nv_bati"]);

/**
 * Classe de repli appliquée par `filterDxfCadastralFeatures` lorsqu'aucun
 * calque DGID n'est reconnu dans le DXF : on reste permissif (toutes les
 * géométries surfaciques deviennent des candidates parcelle, tous les textes
 * sont classés par heuristique).
 */
const FALLBACK_CLASS = "fallback_geometrie";

function getDgidLayerClass(feature: DgidGeoFeature): string {
  return String(feature.properties?._dgid_layer_class ?? "");
}

// ───────────────────────────── Classification des textes ─────────────────────────────

/** Catégorie d'un libellé rattaché à une parcelle. */
type LabelKind = "numero" | "lot" | "proprietaire" | "denomination" | "autre";

const NUMERO_PREFIX = /^(lot|tf|titre\s*foncier|parcelle|n)[°ºo.\s_-]*\d/i;

/** Distingue un "numéro" de parcelle (essentiellement numérique) d'une dénomination. */
function classifyLabelText(raw: string): "numero" | "denomination" {
  const t = raw.trim();
  if (!t) return "denomination";
  if (NUMERO_PREFIX.test(t)) return "numero";
  const digits = (t.match(/\d/g) || []).length;
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  if (digits > 0 && digits >= letters) return "numero";
  return "denomination";
}

/**
 * Détermine la catégorie forcée d'un texte d'après son calque DGID
 * (`_dgid_layer_class`), si reconnu. Retourne `null` si le calque ne permet
 * pas de trancher (repli sur `classifyLabelText`).
 */
function classifyLabelLayer(layerClass: string): LabelKind | null {
  if (NUMERO_PARCELLE_CLASSES.has(layerClass)) return "numero";
  if (NUMERO_LOT_CLASSES.has(layerClass)) return "lot";
  if (PROPRIETAIRE_CLASSES.has(layerClass)) return "proprietaire";
  if (DENOMINATION_CLASSES.has(layerClass)) return "denomination";
  if (OTHER_TEXT_CLASSES.has(layerClass)) return "autre";
  return null;
}

/**
 * Éclate une annotation MTEXT multi-lignes en lignes individuelles (étape 5 :
 * "Mettre les annotations de chaîne de caractères en une seule entité" — une
 * même entité peut alors contenir à la fois le numéro et le titre).
 */
function splitTextLines(raw: string): string[] {
  return raw
    .split(/\\P|\r\n|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ───────────────────────────── Pipeline principal ─────────────────────────────

interface RawPolygon {
  geom: PolygonGeom;
}

interface RawLabel {
  point: [number, number];
  text: string;
  /** Catégorie imposée par le calque DGID, sinon `null` (repli heuristique). */
  cls: LabelKind | null;
}

/** Texte d'un point géolocalisé (libellé de numéro de section à rattacher aux sections). */
interface RawPointText {
  point: [number, number];
  text: string;
}

interface ExtractionResult {
  /** Polygones de parcelles (limites_parcelles / limites_tf / fallback). */
  parcelPolygons: RawPolygon[];
  /** Polygones de sections (limites_sections) — couche-support de jointure. */
  sectionPolygons: RawPolygon[];
  /** Polygones d'emprises de piscines. */
  piscinePolygons: RawPolygon[];
  /** Libellés à rattacher aux parcelles (numéro, lot, propriétaire, dénomination…). */
  labels: RawLabel[];
  /** Libellés de numéro de section à rattacher aux polygones de section. */
  sectionLabels: RawPointText[];
  /**
   * Lignes de limites *ouvertes* regroupées par classe de calque, en vue de la
   * polygonisation (limites dessinées en segments séparés, cf. DGN→DXF).
   */
  boundaryLinesByClass: Record<string, number[][][]>;
  /** Entités écartées car hors de l'emprise UTM28N plausible (parasites CAO). */
  nbHorsEmprise: number;
  nbPolylignesOuvertesIgnorees: number;
  nbAutresCouchesIgnorees: number;
}

/** Classes dont les lignes ouvertes peuvent être polygonisées en surfaces. */
function polygonizableClass(layerClass: string): boolean {
  return (
    PARCEL_BOUNDARY_CLASSES.has(layerClass) ||
    layerClass === SECTION_BOUNDARY_CLASS ||
    layerClass === PISCINE_CLASS ||
    layerClass === FALLBACK_CLASS
  );
}

function extractPolygonsAndLabels(fc: DgidFeatureCollection): ExtractionResult {
  const parcelPolygons: RawPolygon[] = [];
  const sectionPolygons: RawPolygon[] = [];
  const piscinePolygons: RawPolygon[] = [];
  const labels: RawLabel[] = [];
  const sectionLabels: RawPointText[] = [];
  const boundaryLinesByClass: Record<string, number[][][]> = {};
  let nbHorsEmprise = 0;
  let nbPolylignesOuvertesIgnorees = 0;
  let nbAutresCouchesIgnorees = 0;

  /** Aiguille un polygone vers la bonne couche selon son calque DGID. */
  const routePolygon = (geom: PolygonGeom, layerClass: string): void => {
    // Écarte les parasites CAO (lignes à l'origine, coordonnées aberrantes).
    if (!polygonInSenegalUtm(geom)) {
      nbHorsEmprise++;
      return;
    }
    if (layerClass === PISCINE_CLASS) piscinePolygons.push({ geom });
    else if (layerClass === SECTION_BOUNDARY_CLASS) sectionPolygons.push({ geom });
    else if (IGNORED_BOUNDARY_CLASSES.has(layerClass)) nbAutresCouchesIgnorees++;
    else parcelPolygons.push({ geom });
  };

  /** Collecte une polyligne ouverte pour polygonisation ultérieure, ou l'ignore. */
  const addOpenLine = (coords: number[][], layerClass: string): void => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    if (!ringInSenegalUtm(coords)) {
      nbHorsEmprise++;
      return;
    }
    if (polygonizableClass(layerClass)) {
      (boundaryLinesByClass[layerClass] ||= []).push(coords);
    } else {
      nbPolylignesOuvertesIgnorees++;
    }
  };

  for (const feature of fc.features || []) {
    const geom = feature.geometry as GeoJSON.Geometry | null;
    if (!geom) continue;
    const props = (feature.properties || {}) as Record<string, unknown>;
    const layerClass = getDgidLayerClass(feature);

    if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      routePolygon(geom as PolygonGeom, layerClass);
      continue;
    }

    if (geom.type === "LineString") {
      const ring = lineStringToClosedRing(geom.coordinates);
      if (ring) routePolygon({ type: "Polygon", coordinates: [ring] }, layerClass);
      else addOpenLine(geom.coordinates as number[][], layerClass);
      continue;
    }

    if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates as unknown as number[][][]) {
        const ring = lineStringToClosedRing(line);
        if (ring) routePolygon({ type: "Polygon", coordinates: [ring] }, layerClass);
        else addOpenLine(line, layerClass);
      }
      continue;
    }

    if (geom.type === "Point" || geom.type === "MultiPoint") {
      const rawText = String(
        props.Text ?? props.text ?? props.MTEXT ?? props.mtext ?? props.Label ?? ""
      ).trim();
      if (!rawText) continue;
      const isSectionLabel = layerClass === SECTION_NUMERO_CLASS;
      const cls = layerClass === FALLBACK_CLASS ? null : classifyLabelLayer(layerClass);
      const points: number[][] =
        geom.type === "Point" ? [geom.coordinates as number[]] : (geom.coordinates as number[][]);
      // Étape 5 : une même annotation peut regrouper plusieurs lignes
      // (ex. numéro + titre) — on les éclate avant classification.
      for (const text of splitTextLines(rawText)) {
        for (const pt of points) {
          if (pt.length < 2) continue;
          const point: [number, number] = [pt[0], pt[1]];
          if (isSectionLabel) sectionLabels.push({ point, text });
          else labels.push({ point, text, cls });
        }
      }
    }
  }

  return {
    parcelPolygons,
    sectionPolygons,
    piscinePolygons,
    labels,
    sectionLabels,
    boundaryLinesByClass,
    nbHorsEmprise,
    nbPolylignesOuvertesIgnorees,
    nbAutresCouchesIgnorees,
  };
}

/**
 * Polygonise les limites ouvertes (segments séparés) regroupées par classe et
 * ajoute les surfaces reconstruites aux couches correspondantes.
 * Retourne le nombre de polygones reconstruits et ignorés (hors plage d'aire).
 */
function polygonizeBoundaries(
  boundaryLinesByClass: Record<string, number[][][]>,
  parcelPolygons: RawPolygon[],
  sectionPolygons: RawPolygon[],
  piscinePolygons: RawPolygon[]
): { reconstructed: number; oversized: number } {
  let reconstructed = 0;
  let oversized = 0;

  for (const [layerClass, lines] of Object.entries(boundaryLinesByClass)) {
    if (!lines.length) continue;
    let polygons: GeoJSON.Polygon[];
    try {
      // Filtre uniquement l'aire mini ici ; l'aire maxi est appliquée ensuite
      // pour pouvoir compter l'anneau enveloppe global écarté.
      polygons = polygonizeLines(lines, { minAreaM2: POLYGONIZE_MIN_AREA_M2 });
    } catch (err) {
      console.warn(`[parcelle-ingestion] polygonisation échouée pour ${layerClass}:`, err);
      continue;
    }

    const target =
      layerClass === SECTION_BOUNDARY_CLASS
        ? sectionPolygons
        : layerClass === PISCINE_CLASS
        ? piscinePolygons
        : parcelPolygons;

    for (const geom of polygons) {
      if (geometryAreaM2(geom) > POLYGONIZE_MAX_AREA_M2) {
        oversized++;
        continue;
      }
      target.push({ geom });
      reconstructed++;
    }
  }

  return { reconstructed, oversized };
}

/** Point représentatif garanti à l'intérieur de la géométrie (pour les jointures). */
function representativePoint(geom: PolygonGeom): [number, number] {
  try {
    return turf.pointOnFeature(turf.feature(geom)).geometry.coordinates as [number, number];
  } catch {
    return turf.centroid(turf.feature(geom)).geometry.coordinates as [number, number];
  }
}

// Emprise plausible des coordonnées UTM28N pour le Sénégal (étape 2 :
// vérifier l'unité du dessin — mètres vs millimètres).
const SENEGAL_UTM28N_X_RANGE: [number, number] = [100000, 1000000];
const SENEGAL_UTM28N_Y_RANGE: [number, number] = [900000, 2200000];

/** Vrai si le point (x,y) tombe dans l'emprise UTM28N plausible du Sénégal. */
function pointInSenegalUtm(x: number, y: number): boolean {
  return (
    x >= SENEGAL_UTM28N_X_RANGE[0] && x <= SENEGAL_UTM28N_X_RANGE[1] &&
    y >= SENEGAL_UTM28N_Y_RANGE[0] && y <= SENEGAL_UTM28N_Y_RANGE[1]
  );
}

/** Vrai si tous les sommets d'un anneau sont dans l'emprise plausible. */
function ringInSenegalUtm(coords: number[][]): boolean {
  return coords.every((c) => pointInSenegalUtm(c[0], c[1]));
}

/** Vrai si tous les sommets d'un polygone sont dans l'emprise plausible. */
function polygonInSenegalUtm(geom: PolygonGeom): boolean {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  return polys.every((rings) => rings.every(ringInSenegalUtm));
}

/**
 * Construit les parcelles (jointure spatiale + validation + reprojection) à
 * partir d'une FeatureCollection déjà en EPSG:32628. Applique d'abord la
 * classification DGID (`filterDxfCadastralFeatures`), donc séparée de
 * `ingestDxfToParcelles` pour pouvoir être testée sans dépendre d'`ogr2ogr`.
 */
interface ValidPolygon {
  geom: PolygonGeom;
  surfaceM2: number;
  bbox: BBox;
  geomHash: string;
}

/** Valide une liste de polygones : aire > 0 et validité topologique. */
function validatePolygons(polygons: RawPolygon[]): { valid: ValidPolygon[]; rejected: number } {
  const valid: ValidPolygon[] = [];
  let rejected = 0;
  for (const { geom } of polygons) {
    const surfaceM2 = geometryAreaM2(geom);
    if (surfaceM2 <= 0) {
      rejected++;
      continue;
    }
    let ok = true;
    try {
      ok = turf.booleanValid(turf.feature(geom));
    } catch {
      ok = false;
    }
    if (!ok) {
      rejected++;
      continue;
    }
    valid.push({ geom, surfaceM2, bbox: geometryBBox(geom), geomHash: hashGeometry(geom) });
  }
  return { valid, rejected };
}

/** Trouve l'index du polygone contenant un point, via index en grille. */
function findContainingPolygon(
  point: [number, number],
  polygons: ValidPolygon[],
  index: BBoxGridIndex
): number {
  const pt = turf.point(point);
  for (const idx of index.query(point)) {
    const [bx0, by0, bx1, by1] = polygons[idx].bbox;
    if (point[0] < bx0 || point[0] > bx1 || point[1] < by0 || point[1] > by1) continue;
    if (turf.booleanPointInPolygon(pt, turf.feature(polygons[idx].geom))) return idx;
  }
  return -1;
}

export function buildParcellesFromFc32628(
  fc: GeoJSON.FeatureCollection
): DxfIngestionResult {
  const warnings: string[] = [];

  const classified = filterDxfCadastralFeatures(normalizeFeatureCollection(fc));

  const {
    parcelPolygons,
    sectionPolygons,
    piscinePolygons,
    labels,
    sectionLabels,
    boundaryLinesByClass,
    nbHorsEmprise,
    nbPolylignesOuvertesIgnorees,
    nbAutresCouchesIgnorees,
  } = extractPolygonsAndLabels(classified);

  // Polygonisation des limites dessinées en segments séparés (DGN→DXF) :
  // reconstruit les parcelles/sections/piscines fermées et les ajoute aux
  // couches correspondantes.
  const { reconstructed: nbParcellesPolygonisees, oversized: nbPolygonesEnveloppeIgnores } =
    polygonizeBoundaries(boundaryLinesByClass, parcelPolygons, sectionPolygons, piscinePolygons);

  // Validation géométrique : anneaux fermés, aire > 0, validité topologique.
  const { valid: validParcelsAll, rejected: nbPolygonesInvalidesRejetes } =
    validatePolygons(parcelPolygons);
  const { valid: validSections } = validatePolygons(sectionPolygons);
  const { valid: validPiscines } = validatePolygons(piscinePolygons);

  // Plafond d'aire : un polygone de parcelle plus grand que POLYGONIZE_MAX_AREA_M2
  // est une emprise de zone/anneau enveloppe (pas une parcelle de lotissement).
  // Ne s'applique pas aux sections (par nature plus vastes).
  let nbParcellesTropGrandes = nbPolygonesEnveloppeIgnores;
  const validPolygons = validParcelsAll.filter((p) => {
    if (p.surfaceM2 > POLYGONIZE_MAX_AREA_M2) {
      nbParcellesTropGrandes++;
      return false;
    }
    return true;
  });

  // Étape 2 : plausibilité de l'unité/CRS — alerte si l'emprise sort de la
  // zone UTM28N attendue (signe d'un dessin en millimètres ou mal géoréférencé).
  if (validPolygons.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { bbox } of validPolygons) {
      minX = Math.min(minX, bbox[0]);
      minY = Math.min(minY, bbox[1]);
      maxX = Math.max(maxX, bbox[2]);
      maxY = Math.max(maxY, bbox[3]);
    }
    const [xMin, xMax] = SENEGAL_UTM28N_X_RANGE;
    const [yMin, yMax] = SENEGAL_UTM28N_Y_RANGE;
    if (minX < xMin || maxX > xMax || minY < yMin || maxY > yMax) {
      warnings.push(
        `Emprise des géométries (X:[${minX.toFixed(2)},${maxX.toFixed(2)}], ` +
          `Y:[${minY.toFixed(2)},${maxY.toFixed(2)}]) hors de la plage UTM28N attendue ` +
          `pour le Sénégal (X:[${xMin},${xMax}], Y:[${yMin},${yMax}]) — ` +
          "vérifier l'unité du dessin (mètres vs millimètres, étape 2)."
      );
    }
  }

  // Étape 10 : doublons de géométrie (même empreinte) parmi les polygones valides.
  const hashCounts = new Map<string, number>();
  for (const { geomHash } of validPolygons) {
    hashCounts.set(geomHash, (hashCounts.get(geomHash) ?? 0) + 1);
  }
  let nbDoublonsGeometrie = 0;
  for (const count of Array.from(hashCounts.values())) {
    if (count > 1) nbDoublonsGeometrie += count - 1;
  }

  // Étape 10 : chevauchements entre polygones valides (paires non comptées deux fois).
  const overlapIndex = new BBoxGridIndex(validPolygons.map((p) => p.bbox));
  let nbChevauchements = 0;
  validPolygons.forEach((poly, i) => {
    for (const j of overlapIndex.queryRange(poly.bbox)) {
      if (j <= i) continue;
      const other = validPolygons[j];
      if (!bboxIntersects(poly.bbox, other.bbox)) continue;
      try {
        if (turf.booleanOverlap(turf.feature(poly.geom), turf.feature(other.geom))) {
          nbChevauchements++;
        }
      } catch {
        // géométries non comparables (ex. multipolygones disjoints) : ignorer
      }
    }
  });

  // Jointure spatiale point-dans-polygone via index en grille.
  const index = new BBoxGridIndex(validPolygons.map((p) => p.bbox));
  const labelsByPolygon: RawLabel[][] = validPolygons.map(() => []);
  let nbTextesHorsParcelle = 0;

  for (const label of labels) {
    const idx = findContainingPolygon(label.point, validPolygons, index);
    if (idx >= 0) labelsByPolygon[idx].push(label);
    else nbTextesHorsParcelle++;
  }

  // Numéro de section : rattacher chaque libellé numero_section au polygone de
  // section qui le contient (le texte est placé dans la section).
  const sectionIndex = new BBoxGridIndex(validSections.map((s) => s.bbox));
  const sectionNumeros: (string | null)[] = validSections.map(() => null);
  for (const lbl of sectionLabels) {
    const idx = findContainingPolygon(lbl.point, validSections, sectionIndex);
    if (idx >= 0 && sectionNumeros[idx] === null) {
      sectionNumeros[idx] = normalizeSection(lbl.text);
    }
  }

  // Piscines : rattacher chaque emprise de piscine à la parcelle qui la contient
  // (point représentatif de la piscine dans la parcelle).
  const piscineByParcelle: { count: number; surfaceM2: number }[] = validPolygons.map(() => ({
    count: 0,
    surfaceM2: 0,
  }));
  let surfacePiscinesM2 = 0;
  for (const piscine of validPiscines) {
    surfacePiscinesM2 += piscine.surfaceM2;
    const idx = findContainingPolygon(representativePoint(piscine.geom), validPolygons, index);
    if (idx >= 0) {
      piscineByParcelle[idx].count += 1;
      piscineByParcelle[idx].surfaceM2 += piscine.surfaceM2;
    }
  }

  // Composition des parcelles : classification numero / lot / propriétaire /
  // dénomination par calque DGID (prime sur l'heuristique), jointure section,
  // piscine, puis construction du NICAD (étape : numero_parcelle 5 chiffres).
  const parcelles: ParcelleCandidate[] = [];
  let nbSansNumero = 0;
  let nbSansDenomination = 0;
  let nbSansProprietaire = 0;
  let nbSansSection = 0;
  let nbNumeroNonConforme = 0;
  let surfaceTotaleM2 = 0;

  validPolygons.forEach((poly, idx) => {
    let numero: string | null = null;
    let numeroLot: string | null = null;
    let proprietaire: string | null = null;
    let denomination: string | null = null;
    const autresTextes: string[] = [];

    for (const label of labelsByPolygon[idx]) {
      const cls = label.cls ?? classifyLabelText(label.text);
      if (cls === "numero" && numero === null) numero = label.text;
      else if (cls === "lot" && numeroLot === null) numeroLot = label.text;
      else if (cls === "proprietaire" && proprietaire === null) proprietaire = label.text;
      else if (cls === "denomination" && denomination === null) denomination = label.text;
      else autresTextes.push(label.text);
    }

    // Section : par jointure spatiale parcelle ∈ limites_sections.
    const repPoint = representativePoint(poly.geom);
    const sectionIdx = findContainingPolygon(repPoint, validSections, sectionIndex);
    const numeroSection = sectionIdx >= 0 ? sectionNumeros[sectionIdx] : null;

    // Numéro de parcelle normalisé à 5 chiffres (composante parcelle du NICAD).
    // Le NICAD complet est assemblé après coup, une fois le Syscol résolu par
    // jointure spatiale sur cad_communes_2026 (cf. assign-nicad-2026.ts).
    const numero5 = normalizeNumeroParcelle(numero);
    if (numero5.status === "padded" || numero5.status === "truncated") nbNumeroNonConforme++;

    // Géométrie reprojetée en 4326 + point représentatif intérieur pour la
    // jointure spatiale parcelle ∈ commune 2026.
    const geom4326 = reprojectTo4326(poly.geom);
    const repPoint4326 = representativePoint(geom4326);

    const piscine = piscineByParcelle[idx];

    if (numero === null) nbSansNumero++;
    if (denomination === null) nbSansDenomination++;
    if (proprietaire === null) nbSansProprietaire++;
    if (numeroSection === null) nbSansSection++;
    surfaceTotaleM2 += poly.surfaceM2;

    parcelles.push({
      numero,
      numeroParcelle5: numero5.value,
      numeroLot,
      numeroSection,
      nicad: null,
      syscolCommune2026: null,
      nomCommune2026: null,
      repPoint4326,
      proprietaire,
      denomination,
      autresTextes,
      isPiscine: piscine.count > 0,
      piscineSurfaceM2: piscine.surfaceM2,
      surfaceM2: poly.surfaceM2,
      geomWkt32628: geometryToWkt32628(poly.geom),
      geomGeoJson4326: geom4326,
      geomHash: poly.geomHash,
    });
  });

  const nbPiscines = validPiscines.length;

  if (nbParcellesPolygonisees > 0) {
    warnings.push(
      `${nbParcellesPolygonisees} surface(s) reconstruite(s) par polygonisation des limites ` +
        "dessinées en segments séparés (DXF issu d'une conversion DGN)."
    );
  }
  if (nbHorsEmprise > 0) {
    warnings.push(
      `${nbHorsEmprise} entité(s) écartée(s) car hors de l'emprise UTM28N du Sénégal ` +
        "(lignes parasites/à l'origine du dessin CAO)."
    );
  }
  if (nbParcellesTropGrandes > 0) {
    warnings.push(
      `${nbParcellesTropGrandes} polygone(s) trop grand(s) écarté(s) ` +
        `(> ${POLYGONIZE_MAX_AREA_M2} m² : emprise de zone / anneau enveloppe, pas une parcelle).`
    );
  }
  if (nbPolylignesOuvertesIgnorees > 0) {
    warnings.push(
      `${nbPolylignesOuvertesIgnorees} polyligne(s) ouverte(s)/segment(s) isolé(s) ignoré(s) ` +
        "(limites sur un calque non polygonisable)."
    );
  }
  if (nbAutresCouchesIgnorees > 0) {
    warnings.push(
      `${nbAutresCouchesIgnorees} entité(s) ignorée(s) car situées sur un calque hors parcelle ` +
        "(batiment)."
    );
  }
  if (nbPolygonesInvalidesRejetes > 0) {
    warnings.push(`${nbPolygonesInvalidesRejetes} polygone(s) invalide(s) ou d'aire nulle rejeté(s).`);
  }
  if (nbDoublonsGeometrie > 0) {
    warnings.push(`${nbDoublonsGeometrie} géométrie(s) en double détectée(s) (doublons, étape 10).`);
  }
  if (nbChevauchements > 0) {
    warnings.push(`${nbChevauchements} chevauchement(s) entre parcelles détecté(s) (étape 10).`);
  }
  if (nbTextesHorsParcelle > 0) {
    warnings.push(`${nbTextesHorsParcelle} texte(s)/annotation(s) ne se trouvant à l'intérieur d'aucune parcelle.`);
  }
  if (nbNumeroNonConforme > 0) {
    warnings.push(
      `${nbNumeroNonConforme} numéro(s) de parcelle ajusté(s) à 5 chiffres (padding/troncature) pour le NICAD.`
    );
  }
  if (nbSansSection > 0) {
    warnings.push(
      `${nbSansSection} parcelle(s) sans section rattachée (hors limites_sections ou numero_section absent).`
    );
  }
  if (nbSansProprietaire > 0) {
    warnings.push(`${nbSansProprietaire} parcelle(s) sans propriétaire identifié.`);
  }
  if (nbPiscines > 0) {
    warnings.push(`${nbPiscines} emprise(s) de piscine détectée(s).`);
  }
  if (parcelles.length === 0) {
    warnings.push("Aucune parcelle exploitable trouvée dans ce DXF.");
  }

  return {
    parcelles,
    report: {
      nbParcelles: parcelles.length,
      nbSansNumero,
      nbSansDenomination,
      nbSansProprietaire,
      nbSansSection,
      // Résolus lors de l'assemblage du NICAD (jointure cad_communes_2026).
      nbSansCommune2026: 0,
      nbCommune2026Approx: 0,
      nbNumeroNonConforme,
      nbPiscines,
      nbParcellesPolygonisees,
      nbPolygonesEnveloppeIgnores: nbParcellesTropGrandes,
      nbHorsEmprise,
      nbPolylignesOuvertesIgnorees,
      nbTextesHorsParcelle,
      nbPolygonesInvalidesRejetes,
      nbAutresCouchesIgnorees,
      nbDoublonsGeometrie,
      nbChevauchements,
      surfaceTotaleM2,
      surfacePiscinesM2,
      warnings,
    },
  };
}

/**
 * Pipeline complet : DXF brut → parcelles.
 *
 * 1. Essai du lecteur DXF natif (`dxf-native`) qui déplie les blocs INSERT
 *    (indispensable pour les DXF issus d'une conversion DGN/Microstation, où
 *    les parcelles sont encapsulées dans des blocs anonymes). Les limites en
 *    segments séparés sont polygonisées (cf. `buildParcellesFromFc32628`).
 * 2. Repli sur `ogr2ogr` (conversion générique) si le natif ne produit aucune
 *    parcelle ou échoue.
 */
export async function ingestDxfToParcelles(
  buffer: Buffer,
  fileName: string
): Promise<DxfIngestionResult> {
  try {
    const nativeFc = readDxfWorldFeatures(buffer);
    if (nativeFc.features.length > 0) {
      const nativeResult = buildParcellesFromFc32628(nativeFc);
      if (nativeResult.parcelles.length > 0) return nativeResult;
    }
  } catch (err) {
    console.warn("[parcelle-ingestion] lecteur DXF natif échoué, repli ogr2ogr:", err);
  }

  const fc = await convertDxfToFc32628(buffer, fileName);
  return buildParcellesFromFc32628(fc);
}

/**
 * Convertit les parcelles extraites (étapes 1-10) en FeatureCollection
 * GeoJSON (EPSG:4326) directement exploitable par `analyzeGeoJSON`
 * (`geo-engine.ts`). Le `nicad` (16 caractères, construit depuis le
 * numero_parcelle 5 chiffres + section) est reporté sur la propriété `nicad`
 * afin que la détection NICAD (manquant, doublon, longueur) s'applique aux
 * parcelles issues du DXF.
 */
export function parcellesToFeatureCollection(
  parcelles: ParcelleCandidate[]
): GeoJSON.FeatureCollection<PolygonGeom> {
  return {
    type: "FeatureCollection",
    features: parcelles.map((p) => ({
      type: "Feature",
      geometry: p.geomGeoJson4326,
      properties: {
        nicad: p.nicad ?? "",
        syscol: p.syscolCommune2026 ?? "",
        commune_2026: p.nomCommune2026,
        numero: p.numero,
        numero_parcelle: p.numeroParcelle5,
        numero_lot: p.numeroLot,
        numero_section: p.numeroSection,
        proprietaire: p.proprietaire,
        denomination: p.denomination,
        autres_textes: p.autresTextes,
        is_piscine: p.isPiscine,
        piscine_surface: p.piscineSurfaceM2,
        surface_m2: p.surfaceM2,
        geom_hash: p.geomHash,
      },
    })),
  };
}
