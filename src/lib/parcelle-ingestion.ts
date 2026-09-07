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
 *    exclu, `numero_parcelle` = numéro de parcelle, `numero_tf` = numéro de
 *    Titre Foncier (informatif, hors NICAD), `numero_lot` = lot,
 *    `proprietaire` = propriétaire, `titre_parcelle` = dénomination,
 *    `numero_section` = numéro de section, `numero_batiment`/`nb_nv_bati` =
 *    autres textes). Les annotations MTEXT multi-lignes (étape 5) sont éclatées
 *    ligne par ligne avant classification.
 * 3. Jointures spatiales point-dans-polygone (index en grille type STRtree) :
 *    textes → parcelle (numéro/TF/lot/propriétaire/dénomination), parcelle →
 *    section (numero_section), piscine → parcelle (is_piscine, piscine_surface).
 *    Le calque du texte prime sur l'heuristique. Le numero_parcelle est
 *    normalisé à 5 chiffres pour construire le NICAD (16 caractères, cf. nicad.ts).
 * 4. Validation géométrique (anneaux fermés, aire planaire > 0, validité
 *    topologique, plausibilité de l'emprise UTM28N) et reprojection
 *    EPSG:32628 → EPSG:4326. Détection des doublons et CORRECTION des
 *    chevauchements erronés par retaille de la parcelle non prioritaire
 *    (étape 10 : `resolveParcelleOverlaps`).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import proj4 from "proj4";
import * as turf from "@turf/turf";
import * as jsts from "jsts";
import { resolveOgr2Ogr } from "./dgn-parser";
import {
  filterDxfCadastralFeatures,
  normalizeFeatureCollection,
  type FeatureCollection as DgidFeatureCollection,
  type GeoFeature as DgidGeoFeature,
  type LayerMapping,
} from "./cadastral-filter";
import { normalizeNumeroParcelle, normalizeSection } from "./nicad";
import { readDxfWorldFeatures, decodeMText, type Census } from "./dxf-native";
import { polygonizeLines, type PolygonizeOptions } from "./polygonize";

/** Un dangle unique (cf. `PolygonizeOptions.dangles`) — type dérivé pour éviter la duplication/dérive entre les deux fichiers. */
type DangleInfo = NonNullable<PolygonizeOptions["dangles"]>[number];
/** Une paire quasi-doublon réconciliée (cf. `PolygonizeOptions.nearDuplicateEdges`, § 53 quater). */
type NearDuplicateEdgeInfo = NonNullable<PolygonizeOptions["nearDuplicateEdges"]>[number];

const execFileAsync = promisify(execFile);

// UTM zone 28N (Sénégal) — coordonnées en mètres.
proj4.defs("EPSG:32628", "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs");

export interface ParcelleCandidate {
  numero: string | null;
  /**
   * Numéros de parcelle DISTINCTS trouvés à l'intérieur de cette même limite
   * (> 1 élément ⇒ fusion probable de parcelles voisines — limite mitoyenne
   * absente du réseau, ou trou > tolérance de raccord). `numero` retient le
   * premier trouvé (ordre arbitraire) ; `numeroCandidats` porte tous les
   * candidats pour permettre à l'utilisateur de choisir lequel garder après
   * coup (§ 25, `analyzeGeoJSON · MULTI_NUMERO`). `null` si un seul numéro
   * (ou aucun) — pas d'ambiguïté à signaler.
   */
  numeroCandidats: string[] | null;
  /** Numéro de parcelle normalisé à 5 chiffres (sert à construire le NICAD). */
  numeroParcelle5: string | null;
  numeroLot: string | null;
  /**
   * Numéro de Titre Foncier (calque `numero_tf`). Purement informatif :
   * n'alimente ni le NICAD (`numeroParcelle5`), ni `numeroCandidats`, ni la
   * résolution de débordement — un numéro de TF n'est pas un numéro de parcelle.
   */
  numeroTF: string | null;
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
  /** Parcelles dont Syscol + section viennent de `limite_section` (/cadastre/sections)
   *  plutôt que de la couche DXF `limites_sections` — cf. assign-nicad-2026.ts. */
  nbSectionDepuisTableSections: number;
  /** Parmi celles-ci, rattachées par proximité (hors contenance stricte). */
  nbSectionApprox: number;
  nbNumeroNonConforme: number;
  nbPiscines: number;
  nbParcellesPolygonisees: number;
  /** Zones dont le réseau de limites n'a pas pu être nodé/polygonisé, même après
   *  subdivision maximale (cf. `polygonizeTiled` § 28) : TOUTES les parcelles de
   *  ces zones (géométrie + numéro) sont absentes de cet import. */
  nbZonesPolygonisationEchouee: number;
  nbPolygonesEnveloppeIgnores: number;
  nbHorsEmprise: number;
  nbPolylignesOuvertesIgnorees: number;
  /** Polylignes écartées AVANT polygonisation, bbox < `MIN_BOUNDARY_LINE_LENGTH_M`
   *  (artefacts de tracé sur le calque des limites — cf. § 47/48). */
  nbLignesTropCourtesIgnorees: number;
  /** Arcs/splines écartés AVANT polygonisation, bbox < `MIN_BOUNDARY_ARC_SPLINE_LENGTH_M`
   *  (fragments de courbe/annotation, très majoritairement du bruit — cf. § 49). */
  nbArcsSplinesCourtsIgnores: number;
  nbTextesHorsParcelle: number;
  /** Numéros de parcelle récupérés par repli débordement (point d'insertion
   *  hors de toute parcelle, ≤ NUMERO_LABEL_OVERFLOW_TOLERANCE_M) — cf. § 23. */
  nbNumerosRecuperesParDebordement: number;
  /** Parcelles contenant plusieurs numéros distincts (fusion probable de voisines). */
  nbParcellesMultiNumeros: number;
  nbPolygonesInvalidesRejetes: number;
  nbAutresCouchesIgnorees: number;
  nbDoublonsGeometrie: number;
  /** Parcelles superposées fusionnées par recouvrement (doublons de représentation). */
  nbDoublonsRecouvrement: number;
  /** Grandes parcelles/enveloppes supprimées car contenant des parcelles numérotées. */
  nbEnveloppesSupprimees: number;
  /** Segments de limite restés pendants après raccord (§ 53) : jamais fermés en
   *  anneau, donc jamais construits en parcelle. Diagnostic (comptage par tuile,
   *  surcompte possible en marge), n'écarte rien de nouveau. */
  nbLimitesNonRefermees: number;
  /** Cf. § 53 quater — paires de lignes quasi-doublons (extrémité libre différente
   *  de quelques mètres, sommet quasi partagé) réconciliées AVANT noding.
   *  Sans ce contrôle, chacune finissait comptée dans `nbLimitesNonRefermees`
   *  et la subdivision qu'elles dessinaient disparaissait. */
  nbAretesQuasiDoublonsReconciliees: number;
  /** Parcelle nettement plus grande (≥ `DXF_OUTLIER_AREA_RATIO`, défaut 3×) que
   *  la médiane de ses voisines spatiales immédiates — signe probable d'une
   *  limite interne restée pendante (§ 53 bis) : plusieurs parcelles fusionnées
   *  en une. Diagnostic pur, ne modifie ni ne rejette rien. */
  nbParcellesSuspectesFusion: number;
  /** Chevauchements erronés (intersection > DXF_OVERLAP_FIX_MIN_M2) détectés entre parcelles. */
  nbChevauchements: number;
  /** Parcelles retaillées (soustraction de la parcelle prioritaire) pour résorber ces chevauchements. */
  nbChevauchementsCorriges: number;
  /** Parcelles retirées car entièrement absorbées par des parcelles prioritaires lors de la retaille. */
  nbParcellesVideesParChevauchement: number;
  surfaceTotaleM2: number;
  surfacePiscinesM2: number;
  warnings: string[];
  /**
   * Réconciliation du lecteur DXF natif : par type d'entité, lues vs émises vs
   * écartées (avec motif). Garantit qu'aucune entité n'est perdue en silence —
   * `seen = emitted + skipped (+ INSERT, conteneur)`. Absent si repli ogr2ogr.
   */
  reconciliation?: Census;
}

/**
 * Section cadastrale extraite de la couche `limites_sections` d'un DXF, avec son
 * numéro (libellé `numero_section` contenu) — brique de la table `limite_section`.
 * La commune/région/département sont résolues ensuite par jointure spatiale
 * (cf. build-sections.ts). Géométrie déjà reprojetée en EPSG:4326.
 */
export interface SectionCandidate {
  numSection: string | null;
  geomGeoJson4326: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  /** Point représentatif intérieur (4326, [lng, lat]) pour la jointure commune. */
  repPoint4326: [number, number];
  surfaceM2: number;
  geomHash: string;
}

export interface DxfIngestionResult {
  parcelles: ParcelleCandidate[];
  /** Sections cadastrales (couche `limites_sections` + `numero_section`). */
  sections: SectionCandidate[];
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
// Détection d'anomalie POST-polygonisation (§ 53 bis, cas Matam_Ourossogui —
// 2 étiquettes distinctes retrouvées dans UN même polygone de 2000 m² alors que
// ses voisines font ~500 m²) : une parcelle ≥ OUTLIER_AREA_RATIO fois la
// médiane de ses voisines spatiales immédiates est un signe probable de limite
// interne restée pendante (§ 53) — le contour extérieur se referme, la
// subdivision interne non. Purement diagnostique : ne modifie ni ne rejette
// rien, juste un avertissement (même esprit que nbLimitesNonRefermees).
// `OUTLIER_MIN_NEIGHBORS` évite un faux positif sur un échantillon local trop
// petit pour qu'une médiane soit significative (parcelle isolée en bord de lot).
const OUTLIER_AREA_RATIO = Number(process.env.DXF_OUTLIER_AREA_RATIO || 3);
const OUTLIER_MIN_NEIGHBORS = 4;
// Longueur mini (diagonale de la bbox, pas la somme des segments) d'une
// polyligne ouverte pour être retenue comme limite de parcelle. Certains DXF
// mélangent, sur le calque des limites, de véritables limites ET des artefacts
// (hachures, coches d'annotation, mini-tracés décoratifs) — sur un lot réel,
// 88 % des segments faisaient < 2 m (moyenne 4,98 m) contre des dizaines de
// mètres pour une vraie limite, causant des tuiles à 30-70k segments/tuile
// plancher (des dizaines de minutes CHACUNE en noding JSTS, cf. § 47). La
// bbox (pas la somme des segments) évite d'écarter une vraie limite juste
// parce qu'elle a un coin anguleux avec un petit segment interne.
const MIN_BOUNDARY_LINE_LENGTH_M = Number(process.env.DXF_MIN_BOUNDARY_LINE_LENGTH_M || 2);
// Seuil spécifique aux entités ARC/SPLINE (courbes) : sur un DXF réel analysé
// (ML/train_line_boundary_classifier.py + ML/threshold_search.py), ces types ne
// faisaient que 8,3 %/3,8 % de vraies limites au global, et 12 %/32 % même parmi
// ceux DÉJÀ retenus par le seuil de 2 m ci-dessus (fragments de courbe d'arrondi,
// annotations) — contre 74,9 % pour LWPOLYLINE. Un seuil dédié plus haut (pas une
// exclusion totale : de vraies limites courbes existent, cf. densifyPolyline)
// réduit ce bruit sans jamais l'écarter silencieusement (compté séparément).
const MIN_BOUNDARY_ARC_SPLINE_LENGTH_M = Number(process.env.DXF_MIN_BOUNDARY_ARC_SPLINE_LENGTH_M || 10);

// Tolérance de raccord des micro-trous (cf. polygonize.ts · healUndershoots)
// SPÉCIFIQUE aux limites de sections : les tracés de sections (numérisés à plus
// petite échelle que les parcelles) portent des trous d'accrochage métriques —
// la tolérance parcelles (25 cm) laisse alors l'anneau ouvert (section perdue)
// ou la limite mitoyenne pendante (sections fusionnées). 1 m reste sans risque :
// deux sommets légitimes d'une section sont à des centaines de mètres.
const SECTION_SNAP_TOLERANCE_M = Number(process.env.DXF_SECTION_SNAP_TOLERANCE_M || 1);

// Rayon de recherche (mètres, EPSG:32628) des parcelles candidates pour un
// numéro de parcelle dont le point d'insertion DÉBORDE hors de toute parcelle,
// ou tombe près d'un bord — cas fréquent en CAO pour une parcelle étroite/
// petite : le texte est décalé vers l'extérieur (ou simplement centré à
// cheval sur la limite) pour rester lisible. Sans repli, `findContainingPolygon`
// (contenance stricte) rejette silencieusement le numéro (`nbTextesHorsParcelle`),
// et la parcelle reste sans numéro alors que le rattachement visuel est
// évident. Ne s'applique QU'aux libellés classés "numero" (cf. § 23/§ 26,
// docs/CONCEPTS-TRAITEMENT-DXF.md) — jamais aux numéros de section
// (`findSectionNumero`, hors DXF depuis § 21).
const NUMERO_LABEL_OVERFLOW_TOLERANCE_M = Number(process.env.DXF_NUMERO_LABEL_TOLERANCE_M || 3);

// Ratio largeur/hauteur moyen par caractère (police CAO condensée type SHX) —
// approximation grossière, aucun rendu de police réel disponible ici. Sert à
// estimer l'emprise occupée par un numéro de parcelle (§ 26) quand son texte
// déborde/chevauche une parcelle voisine.
const TEXT_CHAR_WIDTH_RATIO = Number(process.env.DXF_TEXT_CHAR_WIDTH_RATIO || 0.6);
// Hauteur de repli (m) quand le DXF ne porte pas la hauteur de texte (code
// groupe 40 absent — ex. repli ogr2ogr) — cf. § 26.
const DEFAULT_TEXT_HEIGHT_M = Number(process.env.DXF_DEFAULT_TEXT_HEIGHT_M || 1.5);

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

    try {
      await execFileAsync(resolveOgr2Ogr(), args, {
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 100,
        // CPL_LOG → puits : GDAL émet un « Warning 1: Non closed ring » PAR
        // anneau non fermé (des dizaines de milliers sur un DXF cadastral) ;
        // sans cela, le flot pollue les journaux et gonfle les messages d'erreur.
        env: { ...process.env, CPL_LOG: os.devNull },
      });
    } catch (err) {
      // Résume l'erreur : ne JAMAIS rethrow le stderr brut (peut contenir
      // 100k+ caractères de warnings bénins qui noient la vraie cause).
      const stderr = String((err as { stderr?: string }).stderr ?? "");
      const causes = stderr
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.includes("Non closed ring"))
        .slice(0, 5);
      const base = err instanceof Error ? err.message.split("\n")[0].slice(0, 300) : String(err);
      throw new Error(`ogr2ogr a échoué : ${base}${causes.length ? ` — ${causes.join(" | ")}` : ""}`);
    }

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

export type BBox = [number, number, number, number];

function geometryBBox(geom: PolygonGeom): BBox {
  return turf.bbox(geom) as BBox;
}

/**
 * Index spatial en grille (équivalent léger d'un STRtree) pour limiter le
 * nombre de tests point-dans-polygone lors de la jointure spatiale.
 */
export class BBoxGridIndex {
  private cells = new Map<string, number[]>();
  private cellSize: number;
  private minX: number;
  private minY: number;

  constructor(bboxes: BBox[], targetCellsPerAxis?: number) {
    // Grille adaptative : viser ~2 bbox/cellule pour que les requêtes (jointures,
    // chevauchements) restent quasi linéaires même à 100k+ polygones. Une grille
    // fixe (32×32) entasse des milliers de polygones par cellule sur un grand
    // plan cadastral → comparaisons quasi O(n²).
    if (targetCellsPerAxis == null) {
      targetCellsPerAxis = Math.min(1024, Math.max(32, Math.round(Math.sqrt(bboxes.length / 2))));
    }
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

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Aire de recouvrement de deux bbox (0 si disjointes). */
function bboxOverlapArea(a: BBox, b: BBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

// Ratio de recouvrement (aire d'intersection / plus petite aire) au-delà duquel
// deux polygones sont réputés être la MÊME parcelle (dessinée en double :
// 3DFACE/polyligne fermée + reconstruction depuis segments, ou triangulation
// partielle contenue dans une parcelle). Un vrai voisin cadastral ne partage
// qu'une limite (recouvrement ~0), il n'est donc jamais fusionné.
//
// Deux relations distinctes sont traitées séparément :
//  - COÏNCIDENCE (recouvrement > ratio de la PLUS GRANDE aire) : deux polygones
//    de même emprise = même parcelle dessinée en double (3DFACE + reconstruction
//    depuis segments) → on n'en garde qu'un.
//  - CONTENANCE (recouvrement > ratio de la PLUS PETITE aire, sans coïncidence) :
//    une petite parcelle est ~entièrement à l'intérieur d'une grande. Ce n'est PAS
//    un doublon : les petites parcelles sont réelles et distinctes. Si la petite
//    porte un numéro de parcelle, la grande est une enveloppe/îlot → on SUPPRIME la
//    grande et on garde les petites numérotées. Si la petite n'a pas de numéro,
//    c'est un sliver/triangulation → on la retire et on garde la grande.
const OVERLAP_COINCIDE_RATIO = Number(process.env.DXF_OVERLAP_COINCIDE_RATIO || 0.9);
const OVERLAP_CONTAIN_RATIO = Number(process.env.DXF_OVERLAP_CONTAIN_RATIO || 0.9);

/**
 * Dédoublonne/nettoie les parcelles superposées par recouvrement géométrique.
 * `hasNumero[i]` indique que la parcelle `i` est le plus petit contenant d'un
 * numéro de parcelle (elle porte donc réellement ce numéro). Retourne les
 * parcelles conservées et le décompte des retraits par coïncidence
 * (`removedDuplicates`) et par contenance (`removedContained` : enveloppes +
 * slivers).
 */
function dedupParcellesByOverlap(
  polygons: ValidPolygon[],
  hasNumero: boolean[]
): { kept: ValidPolygon[]; removedDuplicates: number; removedContained: number } {
  const n = polygons.length;
  if (n < 2) return { kept: polygons, removedDuplicates: 0, removedContained: 0 };

  // Union-find pour les grappes de COÏNCIDENCE (vrais doublons de même emprise).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Retraits directs par CONTENANCE (enveloppes englobantes ou slivers internes).
  const contained = new Uint8Array(n);

  const prefilter = Math.min(OVERLAP_COINCIDE_RATIO, OVERLAP_CONTAIN_RATIO);
  const index = new BBoxGridIndex(polygons.map((p) => p.bbox));
  for (let i = 0; i < n; i++) {
    const pi = polygons[i];
    const fi = turf.feature(pi.geom);
    for (const j of index.queryRange(pi.bbox)) {
      if (j <= i) continue;
      const pj = polygons[j];
      if (!bboxIntersects(pi.bbox, pj.bbox)) continue;
      const minArea = Math.min(pi.surfaceM2, pj.surfaceM2);
      const maxArea = Math.max(pi.surfaceM2, pj.surfaceM2);
      if (minArea <= 0) continue;
      // Pré-filtre bon marché : l'intersection réelle ⊆ recouvrement des bbox ;
      // si celui-ci est déjà trop faible, inutile d'appeler turf.intersect
      // (coûteux) — ce qui élimine la grande majorité des voisins mitoyens.
      if (bboxOverlapArea(pi.bbox, pj.bbox) <= prefilter * minArea) continue;
      let inter: GeoJSON.Feature | null = null;
      try {
        inter = turf.intersect(turf.featureCollection([fi, turf.feature(pj.geom)]));
      } catch {
        continue;
      }
      if (!inter?.geometry) continue;
      const ia = geometryAreaM2(inter.geometry as PolygonGeom);

      if (ia / maxArea > OVERLAP_COINCIDE_RATIO) {
        // Même emprise → doublon de représentation.
        union(i, j);
      } else if (ia / minArea > OVERLAP_CONTAIN_RATIO) {
        // La petite est ~entièrement dans la grande.
        const small = pi.surfaceM2 <= pj.surfaceM2 ? i : j;
        const large = small === i ? j : i;
        // Numéro prioritaire : si la petite porte un numéro, la grande est une
        // enveloppe → on la retire ; sinon la petite est un sliver → on la retire.
        if (hasNumero[small]) contained[large] = 1;
        else contained[small] = 1;
      }
    }
  }

  // Représentant de chaque grappe de coïncidence, parmi les non-retirés :
  // préférer la parcelle NUMÉROTÉE, puis la source `polygonized` (réseau planaire
  // propre), puis le plus petit index.
  const better = (a: number, b: number): number => {
    if (hasNumero[a] !== hasNumero[b]) return hasNumero[a] ? a : b;
    const pa = polygons[a];
    const pb = polygons[b];
    if (pa.source !== pb.source) return pa.source === "polygonized" ? a : b;
    return a < b ? a : b;
  };
  const bestByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (contained[i]) continue; // déjà retiré par contenance
    const r = find(i);
    const cur = bestByRoot.get(r);
    bestByRoot.set(r, cur === undefined ? i : better(cur, i));
  }
  const keepIdx = new Set(bestByRoot.values());

  const kept: ValidPolygon[] = [];
  let removedDuplicates = 0;
  let removedContained = 0;
  for (let i = 0; i < n; i++) {
    if (keepIdx.has(i)) kept.push(polygons[i]);
    else if (contained[i]) removedContained++;
    else removedDuplicates++;
  }
  return { kept, removedDuplicates, removedContained };
}

// Aire d'intersection (m²) au-delà de laquelle un chevauchement entre deux
// parcelles conservées est un CHEVAUCHEMENT ERRONÉ à corriger (étape 10).
// En-dessous : recouvrement de mitoyenneté (bavure de numérisation de quelques
// cm le long d'une limite partagée) — le retailler n'apporte rien visuellement
// et multiplierait les micro-différences de géométrie.
const OVERLAP_FIX_MIN_M2 = Number(process.env.DXF_OVERLAP_FIX_MIN_M2 || 0.5);

/**
 * Supprime les anneaux/parties d'aire ≤ `minPartAreaM2` d'un (Multi)Polygon —
 * confettis résiduels d'une soustraction géométrique. Retourne `null` si plus
 * rien ne dépasse le plancher (la parcelle a été entièrement absorbée).
 */
function dropTinyParts(geom: PolygonGeom, minPartAreaM2: number): PolygonGeom | null {
  const parts = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const kept = parts.filter(
    (rings) =>
      rings.length > 0 &&
      geometryAreaM2({ type: "Polygon", coordinates: rings }) > minPartAreaM2
  );
  if (kept.length === 0) return null;
  if (kept.length === 1) return { type: "Polygon", coordinates: kept[0] };
  return { type: "MultiPolygon", coordinates: kept };
}

/**
 * Corrige les chevauchements partiels erronés restant APRÈS le dédoublonnage
 * par recouvrement (qui ne traite que la coïncidence et la contenance > 90 %).
 * Deux parcelles qui se chevauchent de plus de `OVERLAP_FIX_MIN_M2` ne peuvent
 * pas être toutes deux correctes : le cadastre est une partition planaire.
 *
 * Résolution : la parcelle la moins prioritaire est RETAILLÉE (soustraction de
 * la géométrie de la gagnante), pas supprimée — sa partie non contestée reste
 * une parcelle réelle. Priorité (même philosophie que `dedupParcellesByOverlap`) :
 * numérotée > plus petite aire (l'élémentaire l'emporte sur l'englobante) >
 * source `polygonized` (réseau planaire propre) > index.
 *
 * Les perdantes sont traitées de la meilleure à la moins bonne et se
 * soustraient la géométrie COURANTE de leurs gagnantes (déjà finalisées grâce
 * à cet ordre) : pas de trous fantômes là où une gagnante a elle-même été
 * retaillée. Une perdante réduite à des confettis (< POLYGONIZE_MIN_AREA_M2)
 * est retirée et comptabilisée (`nbParcellesVidees`).
 */
function resolveParcelleOverlaps(
  polygons: ValidPolygon[],
  hasNumero: boolean[],
  index: BBoxGridIndex
): {
  kept: ValidPolygon[];
  nbChevauchements: number;
  nbParcellesRetaillees: number;
  nbParcellesVidees: number;
} {
  const n = polygons.length;
  const noop = { kept: polygons, nbChevauchements: 0, nbParcellesRetaillees: 0, nbParcellesVidees: 0 };
  if (n < 2) return noop;

  const beats = (a: number, b: number): boolean => {
    if (hasNumero[a] !== hasNumero[b]) return hasNumero[a];
    const pa = polygons[a];
    const pb = polygons[b];
    if (pa.surfaceM2 !== pb.surfaceM2) return pa.surfaceM2 < pb.surfaceM2;
    if (pa.source !== pb.source) return pa.source === "polygonized";
    return a < b;
  };

  // 1) Détection des paires en conflit sur les géométries D'ORIGINE (l'ensemble
  // des conflits ne dépend donc pas de l'ordre de correction).
  const winnersOf = new Map<number, number[]>();
  let nbChevauchements = 0;
  for (let i = 0; i < n; i++) {
    const pi = polygons[i];
    const fi = turf.feature(pi.geom);
    for (const j of index.queryRange(pi.bbox)) {
      if (j <= i) continue;
      const pj = polygons[j];
      if (!bboxIntersects(pi.bbox, pj.bbox)) continue;
      // L'aire d'intersection réelle est majorée par celle des bbox : pré-filtre
      // bon marché qui élimine les simples voisins mitoyens.
      if (bboxOverlapArea(pi.bbox, pj.bbox) <= OVERLAP_FIX_MIN_M2) continue;
      let inter: GeoJSON.Feature | null = null;
      try {
        inter = turf.intersect(turf.featureCollection([fi, turf.feature(pj.geom)]));
      } catch {
        continue;
      }
      if (!inter?.geometry) continue;
      if (geometryAreaM2(inter.geometry as PolygonGeom) <= OVERLAP_FIX_MIN_M2) continue;
      nbChevauchements++;
      const winner = beats(i, j) ? i : j;
      const loser = winner === i ? j : i;
      const arr = winnersOf.get(loser);
      if (arr) arr.push(winner);
      else winnersOf.set(loser, [winner]);
    }
  }
  if (winnersOf.size === 0) return { ...noop, nbChevauchements };

  // 2) Retaille, meilleure priorité d'abord. `current[i] === null` = parcelle vidée.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (beats(a, b) ? -1 : 1));
  const current: (PolygonGeom | null)[] = polygons.map((p) => p.geom);
  let nbParcellesRetaillees = 0;
  let nbParcellesVidees = 0;
  for (const idx of order) {
    const winners = winnersOf.get(idx);
    if (!winners) continue;
    let geom: PolygonGeom | null = polygons[idx].geom;
    let changed = false;
    for (const w of winners) {
      if (!geom) break;
      const wGeom = current[w];
      if (!wGeom) continue; // gagnante elle-même vidée entre-temps : plus de conflit
      try {
        const diff = turf.difference(
          turf.featureCollection([turf.feature(geom), turf.feature(wGeom)])
        );
        const dGeom = diff?.geometry;
        geom =
          dGeom && (dGeom.type === "Polygon" || dGeom.type === "MultiPolygon")
            ? (dGeom as PolygonGeom)
            : null;
        changed = true;
      } catch {
        // Soustraction impossible (géométries dégénérées) : on conserve la
        // géométrie telle quelle plutôt que de perdre la parcelle.
      }
    }
    if (!changed) continue;
    const cleaned = geom ? dropTinyParts(geom, POLYGONIZE_MIN_AREA_M2) : null;
    if (!cleaned) {
      current[idx] = null;
      nbParcellesVidees++;
    } else {
      current[idx] = cleaned;
      nbParcellesRetaillees++;
    }
  }

  const kept: ValidPolygon[] = [];
  for (let i = 0; i < n; i++) {
    const geom = current[i];
    if (!geom) continue;
    if (geom === polygons[i].geom) {
      kept.push(polygons[i]);
      continue;
    }
    kept.push({
      geom,
      surfaceM2: geometryAreaM2(geom),
      bbox: geometryBBox(geom),
      geomHash: hashGeometry(geom),
      source: polygons[i].source,
    });
  }
  return { kept, nbChevauchements, nbParcellesRetaillees, nbParcellesVidees };
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
const NUMERO_PARCELLE_CLASSES = new Set(["numero_parcelle"]);

/**
 * Calque d'annotation portant le numéro de Titre Foncier. Distinct du numéro de
 * parcelle : conservé dans son propre champ (`numeroTF`), jamais versé au NICAD.
 */
const NUMERO_TF_CLASSES = new Set(["numero_tf"]);

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
type LabelKind = "numero" | "tf" | "lot" | "proprietaire" | "denomination" | "autre";

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
  if (NUMERO_TF_CLASSES.has(layerClass)) return "tf";
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

/**
 * Provenance d'un polygone de parcelle :
 *  - `authored` : dessiné explicitement (polyligne fermée, 3DFACE) ;
 *  - `polygonized` : reconstruit par polygonisation des segments de limites.
 * Sert au dédoublonnage par recouvrement : une même parcelle peut exister dans
 * les deux représentations superposées.
 */
type ParcelSource = "authored" | "polygonized";

interface RawPolygon {
  geom: PolygonGeom;
  source: ParcelSource;
}

interface RawLabel {
  point: [number, number];
  text: string;
  /** Catégorie imposée par le calque DGID, sinon `null` (repli heuristique). */
  cls: LabelKind | null;
  /** Hauteur de texte DXF (mètres, déjà en UTM28N) — `null` si absente du
   *  dessin. Sert à estimer l'emprise occupée par l'étiquette (§ 26). */
  height: number | null;
  /** Justification horizontale DXF (code groupe 72 — 0=Left [défaut], 1=Center,
   *  2=Right, …) — détermine si `point` est le DÉBUT, le CENTRE ou la FIN du
   *  texte (§ 27). */
  hJustify: number;
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
  /**
   * Type DXF source (`_dgid_source_entity` — `LINE`/`LWPOLYLINE`/`ARC`/`SPLINE`…)
   * de chaque ligne de `boundaryLinesByClass`, même ordre/index par classe.
   * Permet de retrouver le vrai type d'origine d'un dangle (§ 53) plutôt que
   * de le deviner via un proxy (nombre de sommets).
   */
  boundarySourceEntityByClass: Record<string, string[]>;
  /** Entités écartées car hors de l'emprise UTM28N plausible (parasites CAO). */
  nbHorsEmprise: number;
  nbPolylignesOuvertesIgnorees: number;
  nbAutresCouchesIgnorees: number;
  /** Polylignes ouvertes écartées AVANT polygonisation, bbox < `MIN_BOUNDARY_LINE_LENGTH_M`
   *  (artefacts de tracé — hachures, coches d'annotation — pas de vraies limites). */
  nbLignesTropCourtesIgnorees: number;
  /** Arcs/splines écartés AVANT polygonisation, bbox < `MIN_BOUNDARY_ARC_SPLINE_LENGTH_M`. */
  nbArcsSplinesCourtsIgnores: number;
}

/** Diagonale (m) de la bbox d'une polyligne — cf. `MIN_BOUNDARY_LINE_LENGTH_M`. */
function lineBBoxDiagonalM(coords: number[][]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
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
  const boundarySourceEntityByClass: Record<string, string[]> = {};
  let nbHorsEmprise = 0;
  let nbPolylignesOuvertesIgnorees = 0;
  let nbAutresCouchesIgnorees = 0;
  let nbLignesTropCourtesIgnorees = 0;
  let nbArcsSplinesCourtsIgnores = 0;

  /** Aiguille un polygone vers la bonne couche selon son calque DGID. */
  const routePolygon = (geom: PolygonGeom, layerClass: string): void => {
    // Écarte les parasites CAO (lignes à l'origine, coordonnées aberrantes).
    if (!polygonInSenegalUtm(geom)) {
      nbHorsEmprise++;
      return;
    }
    if (layerClass === PISCINE_CLASS) piscinePolygons.push({ geom, source: "authored" });
    else if (layerClass === SECTION_BOUNDARY_CLASS) sectionPolygons.push({ geom, source: "authored" });
    else if (IGNORED_BOUNDARY_CLASSES.has(layerClass)) nbAutresCouchesIgnorees++;
    else parcelPolygons.push({ geom, source: "authored" });
  };

  /** Collecte une polyligne ouverte pour polygonisation ultérieure, ou l'ignore. */
  const addOpenLine = (coords: number[][], layerClass: string, sourceEntity?: string): void => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    if (!ringInSenegalUtm(coords)) {
      nbHorsEmprise++;
      return;
    }
    if (polygonizableClass(layerClass)) {
      const isArcOrSpline = sourceEntity === "ARC" || sourceEntity === "SPLINE";
      const minLength = isArcOrSpline ? MIN_BOUNDARY_ARC_SPLINE_LENGTH_M : MIN_BOUNDARY_LINE_LENGTH_M;
      if (lineBBoxDiagonalM(coords) < minLength) {
        if (isArcOrSpline) nbArcsSplinesCourtsIgnores++;
        else nbLignesTropCourtesIgnorees++;
        return;
      }
      (boundaryLinesByClass[layerClass] ||= []).push(coords);
      // Même ordre/index que boundaryLinesByClass[layerClass] — cf. § 53.
      (boundarySourceEntityByClass[layerClass] ||= []).push(sourceEntity ?? "?");
    } else {
      nbPolylignesOuvertesIgnorees++;
    }
  };

  for (const feature of fc.features || []) {
    const geom = feature.geometry as GeoJSON.Geometry | null;
    if (!geom) continue;
    const props = (feature.properties || {}) as Record<string, unknown>;
    const layerClass = getDgidLayerClass(feature);
    const sourceEntity = typeof props._dgid_source_entity === "string" ? props._dgid_source_entity : undefined;

    if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      routePolygon(geom as PolygonGeom, layerClass);
      continue;
    }

    if (geom.type === "LineString") {
      const ring = lineStringToClosedRing(geom.coordinates);
      if (ring) routePolygon({ type: "Polygon", coordinates: [ring] }, layerClass);
      else addOpenLine(geom.coordinates as number[][], layerClass, sourceEntity);
      continue;
    }

    if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates as unknown as number[][][]) {
        const ring = lineStringToClosedRing(line);
        if (ring) routePolygon({ type: "Polygon", coordinates: [ring] }, layerClass);
        else addOpenLine(line, layerClass, sourceEntity);
      }
      continue;
    }

    if (geom.type === "Point" || geom.type === "MultiPoint") {
      // Nettoie les codes de formatage inline MTEXT (\fArial Black|…;, \A1;, {}, …)
      // pour ne garder que le texte lisible (numéro de lot/parcelle, propriétaire).
      // Défensif : couvre aussi le repli ogr2ogr (qui ne passe pas par dxf-native).
      const rawText = decodeMText(
        String(props.Text ?? props.text ?? props.MTEXT ?? props.mtext ?? props.Label ?? "")
      ).trim();
      if (!rawText) continue;
      const isSectionLabel = layerClass === SECTION_NUMERO_CLASS;
      const cls = layerClass === FALLBACK_CLASS ? null : classifyLabelLayer(layerClass);
      const points: number[][] =
        geom.type === "Point" ? [geom.coordinates as number[]] : (geom.coordinates as number[][]);
      // Hauteur/justification de texte (posées par dxf-native.ts · emitText) —
      // absentes du repli ogr2ogr (driver DXF n'expose pas systématiquement
      // ces attributs) : hauteur → repli § 26, justification → Left (§ 27).
      const rawHeight = props.Height ?? props.height;
      const height = typeof rawHeight === "number" && Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : null;
      const rawHJustify = props.HJustify ?? props.hjustify;
      const hJustify = typeof rawHJustify === "number" && Number.isFinite(rawHJustify) ? rawHJustify : 0;
      // Étape 5 : une même annotation peut regrouper plusieurs lignes
      // (ex. numéro + titre) — on les éclate avant classification.
      for (const text of splitTextLines(rawText)) {
        for (const pt of points) {
          if (pt.length < 2) continue;
          const point: [number, number] = [pt[0], pt[1]];
          if (isSectionLabel) sectionLabels.push({ point, text });
          else labels.push({ point, text, cls, height, hJustify });
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
    boundarySourceEntityByClass,
    nbHorsEmprise,
    nbPolylignesOuvertesIgnorees,
    nbAutresCouchesIgnorees,
    nbLignesTropCourtesIgnorees,
    nbArcsSplinesCourtsIgnores,
  };
}

/**
 * Polygonise les limites ouvertes (segments séparés) et ajoute les surfaces
 * reconstruites aux couches correspondantes.
 * Retourne le nombre de polygones reconstruits et ignorés (hors plage d'aire).
 *
 * Les classes de limites de PARCELLE (limites_parcelles, limites_tf, repli)
 * forment UN SEUL réseau de polygonisation : polygonisées classe par classe,
 * une limite mitoyenne dessinée sur un autre calque que ses voisines (niveau
 * Microstation différent, limite TF adjacente) manquait au réseau de sa classe
 * → les deux parcelles sortaient FUSIONNÉES sous un seul numéro. Les limites de
 * sections y sont ajoutées comme ARÊTES DE DÉCOUPE (une limite de section est
 * par définition aussi une limite de parcelle) tout en restant polygonisées à
 * part pour la table des sections. Les piscines restent un réseau séparé (une
 * piscine est DANS une parcelle : ses contours ne doivent pas la découper).
 */
function polygonizeBoundaries(
  boundaryLinesByClass: Record<string, number[][][]>,
  boundarySourceEntityByClass: Record<string, string[]>,
  parcelPolygons: RawPolygon[],
  sectionPolygons: RawPolygon[],
  piscinePolygons: RawPolygon[]
): {
  reconstructed: number;
  oversized: number;
  droppedRegions: Array<{ x0: number; y0: number; x1: number; y1: number; segments: number }>;
  /** Cf. § 53, docs/CONCEPTS-TRAITEMENT-DXF.md — segments restés pendants après raccord. */
  dangles: DangleInfo[];
  /** Cf. § 53 quater — quasi-doublons réconciliés avant noding. */
  nearDuplicateEdges: NearDuplicateEdgeInfo[];
} {
  let reconstructed = 0;
  let oversized = 0;
  const droppedRegions: Array<{ x0: number; y0: number; x1: number; y1: number; segments: number }> = [];
  const dangles: DangleInfo[] = [];
  const nearDuplicateEdges: NearDuplicateEdgeInfo[] = [];

  // Arêtes des polygones de section « authored » (polylignes fermées/3DFACE du
  // calque sections, routés en polygones AVANT cet appel) : une limite mitoyenne
  // OUVERTE ne peut refermer une face que si le contour fermé sur lequel elle
  // s'appuie fait partie du réseau nodé. Sans ces arêtes, les faces
  // polygonisées débordaient les contours fermés (sections fusionnées, libellés
  // orphelins). Les anneaux de sections se comptent en dizaines : coût marginal.
  // Dérivées d'un polygone déjà fermé (pas d'une ligne source unique) — aucun
  // `_dgid_source_entity` à leur associer, taguées "RING_EDGE".
  const authoredSectionEdges: number[][][] = [];
  const authoredSectionEdgeSourceEntities: string[] = [];
  for (const sp of sectionPolygons) {
    const polys = sp.geom.type === "Polygon" ? [sp.geom.coordinates] : sp.geom.coordinates;
    for (const rings of polys) {
      for (const ring of rings) {
        authoredSectionEdges.push(ring as number[][]);
        authoredSectionEdgeSourceEntities.push("RING_EDGE");
      }
    }
  }

  // NB : pas de `push(...gros_tableau)` ici — le spread passe chaque ligne en
  // argument d'appel et fait déborder la pile au-delà de ~100k éléments
  // (RangeError sur les calques départementaux type limites_parcelles).
  // `*SourceEntities` reste STRICTEMENT en lockstep (même ordre, même longueur)
  // avec le tableau de lignes correspondant — cf. § 53 (type source exact d'un
  // dangle, plutôt qu'un proxy déduit du nombre de sommets).
  const sectionLines: number[][][] = [];
  const sectionLineSourceEntities: string[] = [];
  const sectionSrc = boundarySourceEntityByClass[SECTION_BOUNDARY_CLASS] ?? [];
  (boundaryLinesByClass[SECTION_BOUNDARY_CLASS] ?? []).forEach((l, i) => {
    sectionLines.push(l);
    sectionLineSourceEntities.push(sectionSrc[i] ?? "?");
  });
  for (let i = 0; i < authoredSectionEdges.length; i++) {
    sectionLines.push(authoredSectionEdges[i]);
    sectionLineSourceEntities.push(authoredSectionEdgeSourceEntities[i]);
  }
  const piscineLines = boundaryLinesByClass[PISCINE_CLASS] ?? [];
  const piscineLineSourceEntities = boundarySourceEntityByClass[PISCINE_CLASS] ?? [];
  // Réseau de BASE (sans arêtes d'anneau "authored" réinjectées) — construit
  // AVANT la détection § 53 bis ci-dessous, qui en a besoin pour son passage
  // à blanc.
  const parcelLines: number[][][] = [];
  const parcelLineSourceEntities: string[] = [];
  for (const [layerClass, lines] of Object.entries(boundaryLinesByClass)) {
    if (layerClass === SECTION_BOUNDARY_CLASS || layerClass === PISCINE_CLASS) continue;
    const src = boundarySourceEntityByClass[layerClass] ?? [];
    lines.forEach((l, i) => {
      parcelLines.push(l);
      parcelLineSourceEntities.push(src[i] ?? "?");
    });
  }
  for (let i = 0; i < sectionLines.length; i++) {
    parcelLines.push(sectionLines[i]);
    parcelLineSourceEntities.push(sectionLineSourceEntities[i]);
  }

  // Anneaux "authored" (déjà fermés — ex. grand `Shape` MicroStation
  // englobant un îlot) dont le bord referme un VRAI dangle du réseau
  // parcelles : § 53 bis, docs/CONCEPTS-TRAITEMENT-DXF.md. Un tel anneau
  // routé tel quel (comportement d'origine) empêche STRUCTURELLEMENT ses
  // subdivisions intérieures de jamais se fermer — son bord n'entre jamais
  // dans le graphe de noding, même à écart nul, car `routePolygon`
  // (extractPolygonsAndLabels) le sort du circuit avant même la
  // construction de `boundaryLinesByClass`.
  //
  // Détection par DANGLE RÉEL, pas par simple proximité de N'IMPORTE
  // QUELLE ligne ouverte (v1, abandonnée) : un passage à blanc du réseau
  // `parcelLines` SANS aucune arête d'anneau donne les vrais segments qui
  // échouent structurellement à se refermer (`polygonizer.getDangles()`,
  // même mécanisme que § 53) ; seuls LEURS extrémités libres (p0/p1, pas
  // l'enveloppe) sont testées contre le bord des anneaux `authored`. Une
  // parcelle ordinaire dont les voisines se referment déjà normalement ne
  // produit jamais un tel dangle — donc jamais candidate, quelle que soit
  // sa proximité avec un anneau voisin. Mesuré sur ZIG.dxf complet
  // (production, `layerMapping` réel) : la détection par proximité SEULE
  // (v1) marquait 55 431/89 142 anneaux (62 %, médiane d'aire 300 m² — des
  // parcelles ordinaires) et provoquait 1 152 zones de polygonisation
  // perdues (segments quasi-dupliqués à grande échelle, § 4/« Espace
  // Vert ») ; un filtre de taille seul (v2, > `POLYGONIZE_MAX_AREA_M2`) les
  // ramenait à 97 mais ratait les petits îlots à quelques parcelles. La
  // détection par dangle réel (v3) est à la fois plus SÛRE (ne réagit qu'à
  // un échec de fermeture avéré, jamais à une simple mitoyenneté) et plus
  // COMPLÈTE (aucune restriction de taille) — combine les deux garanties.
  const RING_TOUCH_TOLERANCE_M = Number(process.env.DXF_RING_TOUCH_TOLERANCE_M || 1);
  const ringEdgeLines: number[][][] = [];
  const ringEdgeSourceEntities: string[] = [];
  if (parcelPolygons.length > 0 && parcelLines.length > 0) {
    const dryDangles: DangleInfo[] = [];
    try {
      // Résultat ignoré : seul `dryDangles` nous intéresse ici. `droppedRegions`
      // isolé dans un tableau jetable — ce passage à blanc ne doit pas polluer
      // le compteur final (§ 28), le VRAI passage plus bas le renseignera.
      polygonizeLines(parcelLines, {
        minAreaM2: POLYGONIZE_MIN_AREA_M2,
        droppedRegions: [],
        dangles: dryDangles,
        lineSourceEntities: parcelLineSourceEntities,
      });
    } catch (err) {
      console.warn("[parcelle-ingestion] passage à blanc § 53 bis échoué (ignoré) :", err);
    }

    if (dryDangles.length > 0) {
      const ringIndex = new BBoxGridIndex(parcelPolygons.map((p) => geometryBBox(p.geom)));
      const touchedRingIdx = new Set<number>();
      for (const dangle of dryDangles) {
        for (const endpoint of [dangle.p0, dangle.p1]) {
          const queryBox: BBox = [
            endpoint[0] - RING_TOUCH_TOLERANCE_M,
            endpoint[1] - RING_TOUCH_TOLERANCE_M,
            endpoint[0] + RING_TOUCH_TOLERANCE_M,
            endpoint[1] + RING_TOUCH_TOLERANCE_M,
          ];
          for (const idx of ringIndex.queryRange(queryBox)) {
            if (touchedRingIdx.has(idx)) continue;
            if (pointToPolygonBoundaryDistanceM(endpoint, parcelPolygons[idx].geom) <= RING_TOUCH_TOLERANCE_M) {
              touchedRingIdx.add(idx);
            }
          }
        }
      }

      if (touchedRingIdx.size > 0) {
        const kept: RawPolygon[] = [];
        parcelPolygons.forEach((p, idx) => {
          if (!touchedRingIdx.has(idx)) {
            kept.push(p);
            return;
          }
          const polys = p.geom.type === "Polygon" ? [p.geom.coordinates] : p.geom.coordinates;
          for (const rings of polys) {
            for (const ring of rings) {
              ringEdgeLines.push(ring as number[][]);
              ringEdgeSourceEntities.push("RING_EDGE");
            }
          }
        });
        // Mutation en place : `parcelPolygons` est la MÊME référence détenue par
        // l'appelant (buildParcellesFromFc32628) — cf. `net.target.push(...)`
        // plus bas, qui repose déjà sur cette mutation partagée.
        parcelPolygons.length = 0;
        parcelPolygons.push(...kept);
      }
    }
  }

  // Arêtes des anneaux "authored" touchés (§ 53 bis, ci-dessus) — réinjectées
  // dans le MÊME réseau que les limites ouvertes pour que noding/polygonizer
  // puisse enfin raccorder leurs subdivisions intérieures à leur bord.
  for (let i = 0; i < ringEdgeLines.length; i++) {
    parcelLines.push(ringEdgeLines[i]);
    parcelLineSourceEntities.push(ringEdgeSourceEntities[i]);
  }

  const networks: Array<{
    label: string;
    lines: number[][][];
    sourceEntities: string[];
    target: RawPolygon[];
    isSection: boolean;
    snapTol?: number;
  }> = [
    { label: "limites de parcelles (réseau unifié)", lines: parcelLines, sourceEntities: parcelLineSourceEntities, target: parcelPolygons, isSection: false },
    {
      label: SECTION_BOUNDARY_CLASS,
      lines: sectionLines,
      sourceEntities: sectionLineSourceEntities,
      target: sectionPolygons,
      isSection: true,
      // Tolérance élargie : trous d'accrochage métriques sur les tracés de sections.
      snapTol: SECTION_SNAP_TOLERANCE_M,
    },
    { label: PISCINE_CLASS, lines: piscineLines, sourceEntities: piscineLineSourceEntities, target: piscinePolygons, isSection: false },
  ];

  for (const net of networks) {
    if (!net.lines.length) continue;
    let polygons: GeoJSON.Polygon[];
    try {
      // Filtre uniquement l'aire mini ici ; l'aire maxi est appliquée ensuite
      // pour pouvoir compter l'anneau enveloppe global écarté.
      polygons = polygonizeLines(net.lines, {
        minAreaM2: POLYGONIZE_MIN_AREA_M2,
        ...(net.snapTol != null ? { snapToleranceM: net.snapTol } : {}),
        droppedRegions,
        dangles,
        nearDuplicateEdges,
        lineSourceEntities: net.sourceEntities,
      });
    } catch (err) {
      console.warn(`[parcelle-ingestion] polygonisation échouée pour ${net.label}:`, err);
      continue;
    }

    for (const geom of polygons) {
      // Le plafond d'aire écarte l'anneau enveloppe global / les emprises de zone
      // parmi les PARCELLES. Il ne doit PAS s'appliquer aux sections : une section
      // cadastrale est par nature vaste (souvent > POLYGONIZE_MAX_AREA_M2). Sans
      // cette exemption, tous les polygones de section reconstruits étaient jetés
      // → aucune section rattachée → numero_section absent → NICAD sans section
      // (000) → collisions massives de NICAD (faux doublons).
      if (!net.isSection && geometryAreaM2(geom) > POLYGONIZE_MAX_AREA_M2) {
        oversized++;
        continue;
      }
      net.target.push({ geom, source: "polygonized" });
      reconstructed++;
    }
  }

  return { reconstructed, oversized, droppedRegions, dangles, nearDuplicateEdges };
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
  source: ParcelSource;
}

/**
 * Valide une liste de polygones : aire > 0 et, par défaut, validité topologique
 * (`turf.booleanValid`).
 *
 * `requireValid: false` désactive le contrôle de validité topologique. À utiliser
 * pour les couches servant UNIQUEMENT de support de jointure spatiale (sections) :
 * les tracés de section exportés de Microstation sont fréquemment auto-intersectants
 * (anneaux jugés invalides), alors qu'ils restent parfaitement exploitables en
 * point-dans-polygone. Les rejeter vidait `validSections` → aucune section
 * rattachée → NICAD sans section ("000") → collisions massives de NICAD (faux
 * doublons). On les conserve donc pour la seule jointure de contenance.
 */
const jstsReader = new jsts.io.GeoJSONReader();
const jstsWriter = new jsts.io.GeoJSONWriter();

/**
 * Répare un polygone topologiquement invalide via `buffer(0)` (JSTS) : les
 * anneaux auto-tangents / auto-intersectants issus de polylignes Microstation
 * fermées sont réassemblés en polygone(s) valide(s). Retourne `null` si la
 * réparation échoue ou produit une géométrie vide/non surfacique.
 */
function repairPolygonGeometry(geom: PolygonGeom): PolygonGeom | null {
  try {
    const fixed = jstsReader.read(geom).buffer(0);
    if (!fixed || fixed.isEmpty()) return null;
    const out = jstsWriter.write(fixed) as GeoJSON.Geometry;
    if (out.type === "Polygon" || out.type === "MultiPolygon") return out as PolygonGeom;
    return null;
  } catch {
    return null;
  }
}

function validatePolygons(
  polygons: RawPolygon[],
  opts: { requireValid?: boolean; minAreaM2?: number } = {}
): { valid: ValidPolygon[]; rejected: number; repaired: number } {
  const requireValid = opts.requireValid !== false;
  // Plancher d'aire : écarte les micro-anneaux (symboles CIRCLE, slivers de
  // triangulation 3DFACE) qui, sinon, deviennent des « parcelles » à ~0 m². 0 =
  // pas de plancher (sections/piscines). Une vraie parcelle cadastrale dépasse
  // largement ce seuil ; le rejet est comptabilisé (`rejected`), donc visible.
  const minArea = Math.max(0, opts.minAreaM2 ?? 0);
  const valid: ValidPolygon[] = [];
  let rejected = 0;
  let repaired = 0;
  const push = (g: PolygonGeom, area: number, source: ParcelSource) =>
    valid.push({ geom: g, surfaceM2: area, bbox: geometryBBox(g), geomHash: hashGeometry(g), source });

  for (const { geom, source } of polygons) {
    const surfaceM2 = geometryAreaM2(geom);
    if (surfaceM2 <= minArea) {
      rejected++;
      continue;
    }
    if (requireValid) {
      let ok = true;
      try {
        ok = turf.booleanValid(turf.feature(geom));
      } catch {
        ok = false;
      }
      if (!ok) {
        // Avant de rejeter : tenter une réparation géométrique (buffer(0)).
        // Les polylignes fermées de Microstation/AutoCAD sont massivement
        // auto-tangentes ; les jeter privait l'import de ~87 % des parcelles
        // déjà closes. On ne rejette donc que si la réparation échoue.
        const fixed = repairPolygonGeometry(geom);
        const fixedArea = fixed ? geometryAreaM2(fixed) : 0;
        if (fixed && fixedArea > minArea) {
          push(fixed, fixedArea, source);
          repaired++;
        } else {
          rejected++;
        }
        continue;
      }
    }
    push(geom, surfaceM2, source);
  }
  return { valid, rejected, repaired };
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

/**
 * Trouve l'index du PLUS PETIT polygone contenant un point. Un numéro de
 * parcelle placé à l'intérieur d'un îlot/enveloppe est géométriquement dans la
 * grande ET dans la petite parcelle ; il « appartient » à la plus fine (la
 * parcelle qu'il annote). Sert à savoir quelle parcelle porte réellement un
 * numéro pour le dédoublonnage par contenance.
 */
function findSmallestContainingPolygon(
  point: [number, number],
  polygons: ValidPolygon[],
  index: BBoxGridIndex
): number {
  const pt = turf.point(point);
  let best = -1;
  let bestArea = Infinity;
  for (const idx of index.query(point)) {
    const p = polygons[idx];
    if (p.surfaceM2 >= bestArea) continue;
    const [bx0, by0, bx1, by1] = p.bbox;
    if (point[0] < bx0 || point[0] > bx1 || point[1] < by0 || point[1] > by1) continue;
    if (turf.booleanPointInPolygon(pt, turf.feature(p.geom))) {
      best = idx;
      bestArea = p.surfaceM2;
    }
  }
  return best;
}

// Distance point-segment PLANAIRE (mètres, coordonnées déjà en UTM28N à ce
// stade du pipeline) — jamais `turf.pointToPolygonDistance`/`turf.distance` :
// ces fonctions turf supposent des degrés géodésiques ([lng, lat]) et
// renvoient des valeurs aberrantes sur des coordonnées planaires en mètres
// (cf. docs/CONCEPTS-TRAITEMENT-DXF.md § 23).
function pointToSegmentDistanceM(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pointToRingDistanceM(point: [number, number], ring: number[][]): number {
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = pointToSegmentDistanceM(point, ring[i] as [number, number], ring[i + 1] as [number, number]);
    if (d < min) min = d;
  }
  return min;
}

/** Distance d'un point au contour (anneaux extérieurs ET trous) d'un Polygon/MultiPolygon. */
function pointToPolygonBoundaryDistanceM(point: [number, number], geom: PolygonGeom): number {
  const rings: number[][][] = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  let min = Infinity;
  for (const ring of rings) {
    const d = pointToRingDistanceM(point, ring);
    if (d < min) min = d;
  }
  return min;
}

/** Largeur totale estimée (m) de l'emprise occupée par un texte —
 *  approximation grossière (pas de rendu de police réel), cf. § 26. Sert de
 *  dimension à `labelCharacterPoints` et de seuil « assez loin du bord pour
 *  ignorer tout voisin » (`resolveNumeroLabelPolygon`) — la largeur COMPLÈTE,
 *  pas la moitié : pour un texte Left/Right-justifié (§ 27), le débordement
 *  possible s'étend sur TOUTE la largeur dans une seule direction depuis le
 *  point d'insertion, pas symétriquement de part et d'autre. */
function labelWidthM(text: string, height: number | null): number {
  const h = height ?? DEFAULT_TEXT_HEIGHT_M;
  return Math.max(h, h * text.length * TEXT_CHAR_WIDTH_RATIO);
}

/**
 * Points d'échantillonnage, un par caractère, le long de la ligne de base
 * ESTIMÉE du texte — horizontale (la rotation DXF réelle, code groupe 50,
 * n'est pas capturée). Position par rapport au point d'insertion déterminée
 * par `hJustify` (§ 27, code groupe 72) : Left (0, défaut DXF) → le texte
 * COMMENCE au point et s'étend vers la droite ; Right (2) → le texte SE
 * TERMINE au point ; tout autre cas (Center/Middle/Aligned/Fit) → centré sur
 * le point (repli raisonnable en l'absence de calcul dédié pour ces modes
 * moins courants). Chaque point est le centre estimé d'UN caractère.
 */
function labelCharacterPoints(
  point: [number, number],
  text: string,
  height: number | null,
  hJustify: number
): [number, number][] {
  const h = height ?? DEFAULT_TEXT_HEIGHT_M;
  const charWidth = h * TEXT_CHAR_WIDTH_RATIO;
  const n = Math.max(1, text.length);
  const startX =
    hJustify === 2
      ? point[0] - n * charWidth // Right : le texte se termine au point.
      : hJustify === 0
        ? point[0] // Left (défaut) : le texte commence au point.
        : point[0] - (n * charWidth) / 2; // Center/autre : centré.
  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) points.push([startX + (i + 0.5) * charWidth, point[1]]);
  return points;
}

/**
 * Parmi les polygones à portée de `toleranceM` du point, celui qui CONTIENT
 * LE PLUS DE CARACTÈRES du texte (compte des points de `labelCharacterPoints`
 * tombant dans chaque candidat) — pas le plus petit contenant : un numéro
 * dont la majorité des caractères tombe sur la voisine doit lui être
 * rattaché, que le point d'insertion soit dedans, dehors, ou à cheval sur la
 * limite.
 */
function findPolygonByLabelCharacterCount(
  point: [number, number],
  text: string,
  height: number | null,
  hJustify: number,
  polygons: ValidPolygon[],
  index: BBoxGridIndex,
  toleranceM: number
): number {
  const charPoints = labelCharacterPoints(point, text, height, hJustify);
  const width = labelWidthM(text, height);
  const radius = Math.max(toleranceM, width * 1.2);
  const searchBbox: BBox = [point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius];
  let best = -1;
  let bestCount = 0;
  for (const idx of index.queryRange(searchBbox)) {
    const feature = turf.feature(polygons[idx].geom);
    let count = 0;
    for (const cp of charPoints) {
      if (turf.booleanPointInPolygon(turf.point(cp), feature)) count++;
    }
    if (count > bestCount) {
      best = idx;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Résout la parcelle d'un LIBELLÉ NUMÉRO (§ 26/§ 27) : contenance stricte du
 * point d'insertion d'abord (cas dominant sur un DXF de 100k+ parcelles —
 * chemin bon marché à préserver, cf. § 23). Si le point tombe hors de toute
 * parcelle, OU s'il est contenu mais TROP PRÈS du bord pour exclure qu'un
 * voisin contienne davantage de caractères du texte (distance au bord <
 * largeur totale estimée de l'emprise — pas la moitié, cf. § 27), compare le
 * nombre de caractères tombant sur chaque parcelle à portée
 * (`findPolygonByLabelCharacterCount`) et retient celle qui en contient le
 * plus — au lieu du simple point de contenance/proximité.
 */
function resolveNumeroLabelPolygon(
  point: [number, number],
  text: string,
  height: number | null,
  hJustify: number,
  polygons: ValidPolygon[],
  index: BBoxGridIndex,
  toleranceM: number
): { idx: number; viaFootprint: boolean } {
  const contained = findSmallestContainingPolygon(point, polygons, index);
  if (contained >= 0) {
    const distanceToEdge = pointToPolygonBoundaryDistanceM(point, polygons[contained].geom);
    if (distanceToEdge >= labelWidthM(text, height)) return { idx: contained, viaFootprint: false };
  }
  const byCharCount = findPolygonByLabelCharacterCount(point, text, height, hJustify, polygons, index, toleranceM);
  if (byCharCount >= 0) return { idx: byCharCount, viaFootprint: byCharCount !== contained };
  return { idx: contained, viaFootprint: false };
}

// Profilage par phase (activé via DXF_PROFILE=1) — aucun effet sur le résultat.
const PROFILE = !!process.env.DXF_PROFILE;
function phase(label: string, t0: number): number {
  if (PROFILE) console.log(`[profile] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return Date.now();
}

export interface IngestOptions {
  /** Mappage calque → classe DGID validé par l'utilisateur (variante « simple »). */
  layerMapping?: LayerMapping;
  /**
   * N'extraire QUE les sections (couche `limites_sections`) : court-circuite la
   * composition des parcelles (jointures, dédoublonnage, chevauchements) une fois
   * les sections + numéros résolus. Réutilisé par l'import de `limite_section`.
   */
  sectionsOnly?: boolean;
}

/** Construit un rapport d'ingestion vide (parcours `sectionsOnly`). */
function blankIngestionReport(warnings: string[] = []): DxfIngestionReport {
  return {
    nbParcelles: 0, nbSansNumero: 0, nbSansDenomination: 0, nbSansProprietaire: 0,
    nbSansSection: 0, nbSansCommune2026: 0, nbCommune2026Approx: 0,
    nbSectionDepuisTableSections: 0, nbSectionApprox: 0, nbNumeroNonConforme: 0,
    nbPiscines: 0, nbParcellesPolygonisees: 0, nbZonesPolygonisationEchouee: 0, nbLimitesNonRefermees: 0, nbAretesQuasiDoublonsReconciliees: 0, nbParcellesSuspectesFusion: 0, nbPolygonesEnveloppeIgnores: 0, nbHorsEmprise: 0,
    nbPolylignesOuvertesIgnorees: 0, nbLignesTropCourtesIgnorees: 0, nbArcsSplinesCourtsIgnores: 0, nbTextesHorsParcelle: 0, nbNumerosRecuperesParDebordement: 0,
    nbParcellesMultiNumeros: 0,
    nbPolygonesInvalidesRejetes: 0,
    nbAutresCouchesIgnorees: 0, nbDoublonsGeometrie: 0, nbDoublonsRecouvrement: 0,
    nbEnveloppesSupprimees: 0, nbChevauchements: 0, nbChevauchementsCorriges: 0,
    nbParcellesVideesParChevauchement: 0, surfaceTotaleM2: 0, surfacePiscinesM2: 0,
    warnings,
  };
}

export function buildParcellesFromFc32628(
  fc: GeoJSON.FeatureCollection,
  options: IngestOptions = {}
): DxfIngestionResult {
  const warnings: string[] = [];
  let _t = Date.now();

  // Pas de plafond ici : la classification est intermédiaire (elle alimente la
  // construction des parcelles, pas la réponse HTTP). Tronquer jetterait des
  // limites/numéros/propriétaires avant l'assemblage → parcelles manquantes.
  const classified = filterDxfCadastralFeatures(normalizeFeatureCollection(fc), {
    maxFeatures: null,
    layerMapping: options.layerMapping,
  });
  _t = phase("classify", _t);

  const {
    parcelPolygons,
    sectionPolygons,
    piscinePolygons,
    labels,
    sectionLabels,
    boundaryLinesByClass,
    boundarySourceEntityByClass,
    nbHorsEmprise,
    nbPolylignesOuvertesIgnorees,
    nbAutresCouchesIgnorees,
    nbLignesTropCourtesIgnorees,
    nbArcsSplinesCourtsIgnores,
  } = extractPolygonsAndLabels(classified);
  _t = phase(`extract (parcels=${parcelPolygons.length}, lines=${Object.values(boundaryLinesByClass).reduce((s, a) => s + a.length, 0)})`, _t);

  // Polygonisation des limites dessinées en segments séparés (DGN→DXF) :
  // reconstruit les parcelles/sections/piscines fermées et les ajoute aux
  // couches correspondantes.
  const {
    reconstructed: nbParcellesPolygonisees,
    oversized: nbPolygonesEnveloppeIgnores,
    droppedRegions: nbParcellesZonesIrrecuperablesRegions,
    dangles: limitesNonRefermees,
    nearDuplicateEdges: aretesQuasiDoublonsReconciliees,
  } = polygonizeBoundaries(boundaryLinesByClass, boundarySourceEntityByClass, parcelPolygons, sectionPolygons, piscinePolygons);
  const nbZonesPolygonisationEchouee = nbParcellesZonesIrrecuperablesRegions.length;
  if (nbZonesPolygonisationEchouee > 0) {
    const totalSegments = nbParcellesZonesIrrecuperablesRegions.reduce((s, r) => s + r.segments, 0);
    warnings.push(
      `${nbZonesPolygonisationEchouee} zone(s) n'a/n'ont pas pu être polygonisée(s) (${totalSegments} segments au total, ` +
        `réseau non nodable même après subdivision maximale) : TOUTES les parcelles de ces zones — géométrie ET ` +
        `numéros — sont absentes de cet import. Zones concernées : ` +
        nbParcellesZonesIrrecuperablesRegions
          .slice(0, 5)
          .map((r) => `[${r.x0.toFixed(0)},${r.y0.toFixed(0)}–${r.x1.toFixed(0)},${r.y1.toFixed(0)}] (${r.segments} segments)`)
          .join(" ; ") +
        (nbZonesPolygonisationEchouee > 5 ? `, +${nbZonesPolygonisationEchouee - 5} autre(s)` : "") +
        "."
    );
  }
  // Cf. § 53, docs/CONCEPTS-TRAITEMENT-DXF.md : segments restés pendants (écart
  // premier/dernier sommet > tolérance de raccord) — décompte DIAGNOSTIC, pas
  // une nouvelle règle de rejet (comportement inchangé). En tuilé, un même
  // segment en marge de plusieurs tuiles peut être compté plusieurs fois.
  const nbLimitesNonRefermees = limitesNonRefermees.length;
  if (nbLimitesNonRefermees > 0) {
    const totalLongueurM = limitesNonRefermees.reduce((s, d) => s + d.lengthM, 0);
    // Candidats sûrs pour une fermeture dédiée (§ 53) : écart 1er/dernier
    // sommet ≤ 2 m, sans toucher à `snapToleranceM` (donc sans risque de
    // fusionner deux sommets cadastraux distincts ailleurs dans le fichier).
    const nbEcartFaible = limitesNonRefermees.filter((d) => d.selfGapM <= 2).length;
    // Type DXF source exact (`_dgid_source_entity`, "?" = pas de correspondance
    // exacte — cf. `roundedLineKey`, polygonize.ts) plutôt qu'un proxy déduit
    // du nombre de sommets.
    const bySource = new Map<string, number>();
    for (const d of limitesNonRefermees) bySource.set(d.sourceEntity, (bySource.get(d.sourceEntity) ?? 0) + 1);
    const sourceBreakdown = [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
    warnings.push(
      `${nbLimitesNonRefermees} segment(s) de limite resté(s) pendant(s) après raccord ` +
        `(${totalLongueurM.toFixed(0)} m cumulés, comptage par tuile — surcompte possible en marge) : ` +
        "aucune parcelle reconstruite pour ces segments (écart entre extrémités > tolérance de raccord). " +
        `${nbEcartFaible} ont un écart 1er/dernier sommet ≤ 2 m (candidats probables à une fermeture dédiée). ` +
        `Type source : ${sourceBreakdown}.`
    );
  }
  // Cf. § 53 quater : quasi-doublons AVANT noding (extrémité libre
  // différente de quelques mètres, OU copie partielle posée sur une plus
  // longue — distincts des doublons EXACTS) — réconciliés, pas rejetés : sans
  // ce contrôle, chacune des deux lignes finissait exclue comme dangle (cf.
  // ci-dessus) et la subdivision qu'elles dessinaient disparaissait.
  const nbAretesQuasiDoublonsReconciliees = aretesQuasiDoublonsReconciliees.length;
  if (nbAretesQuasiDoublonsReconciliees > 0) {
    warnings.push(
      `${nbAretesQuasiDoublonsReconciliees} arête(s) quasi-doublon(s) réconciliée(s) avant polygonisation ` +
        "(même limite dessinée deux fois avec une imprécision de digitalisation, sommet quasi partagé) — " +
        "une seule conservée par paire, aucune parcelle rejetée."
    );
  }
  _t = phase(`polygonize (+${nbParcellesPolygonisees})`, _t);

  // Validation géométrique : anneaux fermés, aire > plancher, validité topologique.
  // Plancher = seuil de polygonisation (5 m²) pour homogénéiser parcelles
  // reconstruites et parcelles « authored » (3DFACE/polylignes/CIRCLE) : sans lui,
  // les micro-symboles (cercles de puits, slivers) devenaient des parcelles ~0 m².
  const { valid: validParcelsAll, rejected: nbPolygonesInvalidesRejetes, repaired: nbPolygonesRepares } =
    validatePolygons(parcelPolygons, { minAreaM2: POLYGONIZE_MIN_AREA_M2 });
  // Sections : support de jointure uniquement → on tolère les anneaux invalides
  // (tracés Microstation auto-intersectants) plutôt que de les rejeter.
  const { valid: validSections } = validatePolygons(sectionPolygons, { requireValid: false });
  const { valid: validPiscines } = validatePolygons(piscinePolygons);
  _t = phase(`validate (valid=${validParcelsAll.length})`, _t);

  // ── Sections cadastrales : numéro (libellé numero_section contenu) + géométrie
  // 4326. Calculé ici car indépendant des parcelles : réutilisé plus bas pour la
  // jointure parcelle ∈ section, et permet le parcours rapide `sectionsOnly`
  // (construction de la table limite_section sans composer les parcelles).
  const sectionIndex = new BBoxGridIndex(validSections.map((s) => s.bbox));
  const sectionNumeros: (string | null)[] = validSections.map(() => null);
  // Numéros DISTINCTS vus par polygone de section : > 1 ⇒ fusion probable
  // (limite mitoyenne absente du réseau ou trou > tolérance de raccord).
  const sectionNumerosVus: Array<Set<string>> = validSections.map(() => new Set());
  for (const lbl of sectionLabels) {
    // PLUS PETIT contenant (et non premier trouvé) : un libellé tombe à la fois
    // dans sa section ET dans tout anneau enveloppe/îlot qui l'englobe — au
    // premier trouvé, l'enveloppe raflait les numéros et les vraies sections
    // restaient sans numéro (puis étaient dissoutes/écrasées à tort).
    const idx = findSmallestContainingPolygon(lbl.point, validSections, sectionIndex);
    if (idx >= 0) {
      const num = normalizeSection(lbl.text);
      if (num) {
        sectionNumerosVus[idx].add(num);
        if (sectionNumeros[idx] === null) sectionNumeros[idx] = num;
      }
    }
  }
  const nbSectionsMultiNumeros = sectionNumerosVus.filter((s) => s.size > 1).length;
  const sectionsWarnings: string[] = [];
  if (nbSectionsMultiNumeros > 0) {
    sectionsWarnings.push(
      `${nbSectionsMultiNumeros} section(s) contenant PLUSIEURS numéros de section distincts (` +
        sectionNumerosVus
          .filter((s) => s.size > 1)
          .slice(0, 10)
          .map((s) => [...s].sort().join("+"))
          .join(" ; ") +
        ") : fusion probable de sections voisines — limite mitoyenne absente ou trou > tolérance " +
        "(DXF_SECTION_SNAP_TOLERANCE_M)."
    );
  }
  const sections: SectionCandidate[] = validSections.map((s, i) => {
    const geom4326 = reprojectTo4326(s.geom);
    return {
      numSection: sectionNumeros[i],
      geomGeoJson4326: geom4326,
      repPoint4326: representativePoint(geom4326),
      surfaceM2: s.surfaceM2,
      geomHash: s.geomHash,
    };
  });
  if (options.sectionsOnly) {
    return {
      parcelles: [],
      sections,
      report: blankIngestionReport([
        `${sections.length} section(s) extraite(s) de la couche limites_sections.`,
        ...sectionsWarnings,
      ]),
    };
  }
  warnings.push(...sectionsWarnings);

  // Plafond d'aire : un polygone de parcelle plus grand que POLYGONIZE_MAX_AREA_M2
  // est une emprise de zone/anneau enveloppe (pas une parcelle de lotissement).
  // Ne s'applique pas aux sections (par nature plus vastes).
  let nbParcellesTropGrandes = nbPolygonesEnveloppeIgnores;
  const validPolygonsPreDedup = validParcelsAll.filter((p) => {
    if (p.surfaceM2 > POLYGONIZE_MAX_AREA_M2) {
      nbParcellesTropGrandes++;
      return false;
    }
    return true;
  });

  // Numéro de parcelle prioritaire : marque, pour chaque parcelle candidate, si
  // elle est le PLUS PETIT contenant d'un numéro de parcelle (elle porte donc ce
  // numéro). Un îlot/enveloppe englobant plusieurs parcelles numérotées n'est PAS
  // le plus petit contenant → il ne sera pas marqué, et sera retiré au profit des
  // parcelles numérotées qu'il contient.
  const numeroLabels = labels.filter(
    (l) => (l.cls ?? classifyLabelText(l.text)) === "numero"
  );
  const preIndex = new BBoxGridIndex(validPolygonsPreDedup.map((p) => p.bbox));
  const hasNumero = new Array<boolean>(validPolygonsPreDedup.length).fill(false);
  for (const lbl of numeroLabels) {
    const { idx } = resolveNumeroLabelPolygon(
      lbl.point,
      lbl.text,
      lbl.height,
      lbl.hJustify,
      validPolygonsPreDedup,
      preIndex,
      NUMERO_LABEL_OVERFLOW_TOLERANCE_M
    );
    if (idx >= 0) hasNumero[idx] = true;
  }

  // Dédoublonnage/nettoyage par recouvrement :
  //  - coïncidence (même emprise) : doublon de représentation (3DFACE + segments) → 1 gardé ;
  //  - contenance : une grande parcelle contenant des parcelles NUMÉROTÉES est une
  //    enveloppe/îlot → supprimée au profit des parcelles numérotées (numéro prioritaire).
  const {
    kept: dedupedPolygons,
    removedDuplicates: nbDoublonsRecouvrement,
    removedContained: nbEnveloppesSupprimees,
  } = dedupParcellesByOverlap(validPolygonsPreDedup, hasNumero);
  _t = phase(
    `dedup-overlap (doublons=-${nbDoublonsRecouvrement}, enveloppes=-${nbEnveloppesSupprimees}, kept=${dedupedPolygons.length})`,
    _t
  );

  // Étape 10 : CORRECTION des chevauchements partiels erronés restants (ni
  // coïncidence ni contenance > 90 %, donc hors du champ du dédoublonnage).
  // Le marquage `hasNumero` est recalculé : les indices ont changé au dédoublonnage.
  const dedupIndex = new BBoxGridIndex(dedupedPolygons.map((p) => p.bbox));
  const dedupHasNumero = new Array<boolean>(dedupedPolygons.length).fill(false);
  for (const lbl of numeroLabels) {
    const { idx } = resolveNumeroLabelPolygon(
      lbl.point,
      lbl.text,
      lbl.height,
      lbl.hJustify,
      dedupedPolygons,
      dedupIndex,
      NUMERO_LABEL_OVERFLOW_TOLERANCE_M
    );
    if (idx >= 0) dedupHasNumero[idx] = true;
  }
  const {
    kept: validPolygons,
    nbChevauchements,
    nbParcellesRetaillees: nbChevauchementsCorriges,
    nbParcellesVidees: nbParcellesVideesParChevauchement,
  } = resolveParcelleOverlaps(dedupedPolygons, dedupHasNumero, dedupIndex);
  _t = phase(
    `overlap-fix (chevauchements=${nbChevauchements}, retaillées=${nbChevauchementsCorriges}, vidées=${nbParcellesVideesParChevauchement}, kept=${validPolygons.length})`,
    _t
  );

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
  _t = phase("dedup", _t);

  // (Chevauchements : détectés ET corrigés plus haut par `resolveParcelleOverlaps`.)

  // Jointure spatiale point-dans-polygone via index en grille.
  const index = new BBoxGridIndex(validPolygons.map((p) => p.bbox));
  const labelsByPolygon: RawLabel[][] = validPolygons.map(() => []);
  let nbTextesHorsParcelle = 0;
  let nbNumerosRecuperesParDebordement = 0;

  for (const label of labels) {
    let idx: number;
    // Résolution DÉDIÉE (contenance + repli débordement/emprise de texte,
    // § 23/§ 26) RÉSERVÉE aux numéros de parcelle — un lot/propriétaire/
    // dénomination hors de toute parcelle reste hors parcelle, aucune
    // ambiguïté de lisibilité à corriger pour ces classes.
    if ((label.cls ?? classifyLabelText(label.text)) === "numero") {
      const resolved = resolveNumeroLabelPolygon(
        label.point,
        label.text,
        label.height,
        label.hJustify,
        validPolygons,
        index,
        NUMERO_LABEL_OVERFLOW_TOLERANCE_M
      );
      idx = resolved.idx;
      if (resolved.viaFootprint && idx >= 0) nbNumerosRecuperesParDebordement++;
    } else {
      idx = findContainingPolygon(label.point, validPolygons, index);
    }
    if (idx >= 0) labelsByPolygon[idx].push(label);
    else nbTextesHorsParcelle++;
  }

  // (Numéros de section déjà rattachés plus haut : `sectionNumeros`/`sectionIndex`
  // sont calculés avant le parcours `sectionsOnly` et réutilisés ici.)

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

  // Composition des parcelles : classification numero / TF / lot / propriétaire /
  // dénomination par calque DGID (prime sur l'heuristique), jointure section,
  // piscine, puis construction du NICAD (étape : numero_parcelle 5 chiffres).
  const parcelles: ParcelleCandidate[] = [];
  let nbSansNumero = 0;
  let nbSansDenomination = 0;
  let nbSansProprietaire = 0;
  let nbSansSection = 0;
  let nbNumeroNonConforme = 0;
  let nbParcellesMultiNumeros = 0;
  let surfaceTotaleM2 = 0;

  validPolygons.forEach((poly, idx) => {
    let numero: string | null = null;
    let numeroTF: string | null = null;
    let numeroLot: string | null = null;
    let proprietaire: string | null = null;
    let denomination: string | null = null;
    const autresTextes: string[] = [];
    // Numéros DISTINCTS contenus : > 1 ⇒ fusion probable de parcelles voisines
    // (limite mitoyenne absente du réseau ou trou > tolérance de raccord).
    const numerosVus = new Set<string>();

    for (const label of labelsByPolygon[idx]) {
      const cls = label.cls ?? classifyLabelText(label.text);
      if (cls === "numero") numerosVus.add(label.text.trim());
      if (cls === "numero" && numero === null) numero = label.text;
      else if (cls === "tf" && numeroTF === null) numeroTF = label.text;
      else if (cls === "lot" && numeroLot === null) numeroLot = label.text;
      else if (cls === "proprietaire" && proprietaire === null) proprietaire = label.text;
      else if (cls === "denomination" && denomination === null) denomination = label.text;
      else autresTextes.push(label.text);
    }
    const numeroCandidats = numerosVus.size > 1 ? Array.from(numerosVus) : null;
    if (numeroCandidats) nbParcellesMultiNumeros++;

    // Section : NON résolue depuis la couche DXF `limites_sections` de CE
    // fichier (peu fiable/absente — anneaux invalides rejetés, débordements
    // de numéro non recouvrés, cf. § 9/§ 11 decies) — laissée `null` ici,
    // résolue exclusivement par jointure spatiale sur `limite_section` (table
    // QA construite via /cadastre/sections), l'étape DB suivante du pipeline
    // (cf. `assign-nicad-2026.ts`, § 21).
    const repPoint = representativePoint(poly.geom);
    const numeroSection: string | null = null;

    // Numéro de parcelle normalisé à 5 chiffres (composante parcelle du NICAD).
    // Le NICAD complet est assemblé après coup, une fois Syscol + section
    // résolus par jointure spatiale (cf. assign-nicad-2026.ts).
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
      numeroCandidats,
      numeroParcelle5: numero5.value,
      numeroLot,
      numeroTF,
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

  _t = phase("joins+compose", _t);

  // Détection d'anomalie post-polygonisation (§ 53 bis) : une parcelle
  // nettement plus grande que ses voisines spatiales immédiates. `validPolygons`
  // et `parcelles` restent au même index (une entrée par itération du `forEach`
  // ci-dessus) — bbox prise sur `validPolygons`, jamais recalculée.
  let nbParcellesSuspectesFusion = 0;
  if (parcelles.length > OUTLIER_MIN_NEIGHBORS) {
    const outlierIndex = new BBoxGridIndex(validPolygons.map((p) => p.bbox));
    parcelles.forEach((p, i) => {
      const [bx0, by0, bx1, by1] = validPolygons[i].bbox;
      // Marge locale (échelle du quartier immédiat) : plancher 30 m pour les
      // très petites parcelles, sinon proportionnelle à la taille propre —
      // évite de comparer une parcelle urbaine dense à un hameau lointain sur
      // un fichier à densité très hétérogène.
      const margin = Math.max(30, Math.sqrt(p.surfaceM2) * 4);
      const neighborIdx = outlierIndex
        .queryRange([bx0 - margin, by0 - margin, bx1 + margin, by1 + margin])
        .filter((j) => j !== i);
      if (neighborIdx.length < OUTLIER_MIN_NEIGHBORS) return;
      const neighborAreas = neighborIdx.map((j) => parcelles[j].surfaceM2).sort((a, b) => a - b);
      const medianArea = neighborAreas[Math.floor(neighborAreas.length / 2)];
      if (medianArea > 0 && p.surfaceM2 >= medianArea * OUTLIER_AREA_RATIO) {
        nbParcellesSuspectesFusion++;
      }
    });
  }
  if (nbParcellesSuspectesFusion > 0) {
    warnings.push(
      `${nbParcellesSuspectesFusion} parcelle(s) nettement plus grande(s) que leurs voisines ` +
        `immédiates (≥ ${OUTLIER_AREA_RATIO}× la médiane locale) — signe probable d'une limite ` +
        "interne restée pendante (§ 53) : plusieurs parcelles fusionnées en une, à relire manuellement."
    );
  }

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
  if (nbLignesTropCourtesIgnorees > 0) {
    warnings.push(
      `${nbLignesTropCourtesIgnorees} polyligne(s) trop courte(s) écartée(s) avant polygonisation ` +
        `(bbox < ${MIN_BOUNDARY_LINE_LENGTH_M} m — probable artefact de tracé sur le calque des limites, ` +
        "pas une vraie limite de parcelle)."
    );
  }
  if (nbArcsSplinesCourtsIgnores > 0) {
    warnings.push(
      `${nbArcsSplinesCourtsIgnores} arc(s)/spline(s) trop court(s) écarté(s) avant polygonisation ` +
        `(bbox < ${MIN_BOUNDARY_ARC_SPLINE_LENGTH_M} m — fragment de courbe d'arrondi/annotation, ` +
        "très majoritairement du bruit sur ce type d'entité, pas une vraie limite de parcelle)."
    );
  }
  if (nbAutresCouchesIgnorees > 0) {
    warnings.push(
      `${nbAutresCouchesIgnorees} entité(s) ignorée(s) car situées sur un calque hors parcelle ` +
        "(batiment)."
    );
  }
  if (nbPolygonesRepares > 0) {
    warnings.push(
      `${nbPolygonesRepares} polygone(s) auto-tangent(s)/invalide(s) réparé(s) (buffer(0)) au lieu d'être rejeté(s).`
    );
  }
  if (nbPolygonesInvalidesRejetes > 0) {
    warnings.push(`${nbPolygonesInvalidesRejetes} polygone(s) invalide(s) ou d'aire nulle rejeté(s).`);
  }
  if (nbDoublonsGeometrie > 0) {
    warnings.push(`${nbDoublonsGeometrie} géométrie(s) en double détectée(s) (doublons, étape 10).`);
  }
  if (nbDoublonsRecouvrement > 0) {
    warnings.push(
      `${nbDoublonsRecouvrement} parcelle(s) superposée(s) fusionnée(s) par recouvrement ` +
        "(même parcelle dessinée en 3DFACE/polyligne fermée et reconstruite depuis les segments)."
    );
  }
  if (nbEnveloppesSupprimees > 0) {
    warnings.push(
      `${nbEnveloppesSupprimees} grande(s) parcelle(s)/enveloppe(s) supprimée(s) car contenant ` +
        "des parcelles numérotées (numéro de parcelle prioritaire, îlot/enveloppe écarté)."
    );
  }
  if (nbChevauchements > 0) {
    warnings.push(
      `${nbChevauchements} chevauchement(s) erroné(s) entre parcelles détecté(s) et corrigé(s) (étape 10) : ` +
        `${nbChevauchementsCorriges} parcelle(s) retaillée(s) au profit de la parcelle prioritaire` +
        (nbParcellesVideesParChevauchement > 0
          ? `, ${nbParcellesVideesParChevauchement} parcelle(s) entièrement absorbée(s) retirée(s)`
          : "") +
        "."
    );
  }
  if (nbParcellesMultiNumeros > 0) {
    warnings.push(
      `${nbParcellesMultiNumeros} parcelle(s) contenant PLUSIEURS numéros de parcelle distincts : fusion probable ` +
        "de parcelles voisines (limite mitoyenne absente du dessin ou trou > tolérance de raccord). " +
        "Vérifier le calque de la limite manquante ou augmenter DXF_POLYGONIZE_SNAP_TOLERANCE_M."
    );
  }
  if (nbTextesHorsParcelle > 0) {
    warnings.push(`${nbTextesHorsParcelle} texte(s)/annotation(s) ne se trouvant à l'intérieur d'aucune parcelle.`);
  }
  if (nbNumerosRecuperesParDebordement > 0) {
    warnings.push(
      `${nbNumerosRecuperesParDebordement} numéro(s) de parcelle rattaché(s) par emprise de texte ` +
        `(point d'insertion hors de la parcelle, ou proche d'un bord avec le texte majoritairement ` +
        `sur une parcelle voisine) — à vérifier.`
    );
  }
  if (nbNumeroNonConforme > 0) {
    warnings.push(
      `${nbNumeroNonConforme} numéro(s) de parcelle ajusté(s) à 5 chiffres (padding/troncature) pour le NICAD.`
    );
  }
  // Pas d'avertissement `nbSansSection` ici : la section n'est plus résolue à
  // l'ingestion (cf. § 21) mais à l'étape DB suivante, par jointure sur
  // `limite_section` — `assign-nicad-2026.ts` avertit sur le compte FINAL,
  // après cette résolution, sans quoi ce compte provisoire (tous les
  // parcelles, avant jointure) serait trompeur.
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
    sections,
    report: {
      nbParcelles: parcelles.length,
      nbSansNumero,
      nbSansDenomination,
      nbSansProprietaire,
      nbSansSection,
      // Résolus lors de l'assemblage du NICAD (jointure cad_communes_2026 / limite_section).
      nbSansCommune2026: 0,
      nbCommune2026Approx: 0,
      nbSectionDepuisTableSections: 0,
      nbSectionApprox: 0,
      nbNumeroNonConforme,
      nbPiscines,
      nbParcellesPolygonisees,
      nbZonesPolygonisationEchouee,
      nbLimitesNonRefermees,
      nbAretesQuasiDoublonsReconciliees,
      nbParcellesSuspectesFusion,
      nbPolygonesEnveloppeIgnores: nbParcellesTropGrandes,
      nbHorsEmprise,
      nbPolylignesOuvertesIgnorees,
      nbLignesTropCourtesIgnorees,
      nbArcsSplinesCourtsIgnores,
      nbTextesHorsParcelle,
      nbNumerosRecuperesParDebordement,
      nbParcellesMultiNumeros,
      nbPolygonesInvalidesRejetes,
      nbAutresCouchesIgnorees,
      nbDoublonsGeometrie,
      nbDoublonsRecouvrement,
      nbChevauchementsCorriges,
      nbParcellesVideesParChevauchement,
      nbEnveloppesSupprimees,
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
  fileName: string,
  options: IngestOptions = {}
): Promise<DxfIngestionResult> {
  try {
    const nativeFc = readDxfWorldFeatures(buffer);
    if (nativeFc.features.length > 0) {
      const nativeResult = buildParcellesFromFc32628(nativeFc, options);
      // Critère de succès selon la cible : en `sectionsOnly`, `parcelles` est
      // TOUJOURS vide (court-circuit) — tester les parcelles envoyait chaque
      // import de sections vers ogr2ogr même quand le natif fonctionnait
      // (conversion moins fidèle + déluge « Non closed ring » de GDAL).
      const nativeOk = options.sectionsOnly
        ? nativeResult.sections.length > 0
        : nativeResult.parcelles.length > 0;
      if (nativeOk) {
        // Remonte la réconciliation du lecteur natif dans le rapport.
        if (nativeFc._census) nativeResult.report.reconciliation = nativeFc._census;
        return nativeResult;
      }
    }
  } catch (err) {
    console.warn("[parcelle-ingestion] lecteur DXF natif échoué, repli ogr2ogr:", err);
  }

  const fc = await convertDxfToFc32628(buffer, fileName);
  return buildParcellesFromFc32628(fc, options);
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
        numero_candidats: p.numeroCandidats,
        numero_parcelle: p.numeroParcelle5,
        numero_lot: p.numeroLot,
        numero_tf: p.numeroTF,
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
