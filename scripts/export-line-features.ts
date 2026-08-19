/**
 * Exporte, pour un DXF cadastral et l'analyse (parcelles) qui en a été construite,
 * un CSV de features géométriques par polyligne candidate au réseau de
 * polygonisation (calques limites_parcelles / limites_tf / limites_sections /
 * piscine), avec une étiquette faible (weak label) : la ligne a-t-elle
 * effectivement fini sur le contour d'une parcelle finale, ou non ?
 *
 * Sert de jeu d'entraînement à ML/train_line_boundary_classifier.py, qui apprend
 * à remplacer le seuil fixe `MIN_BOUNDARY_LINE_LENGTH_M` (bbox diagonale < 2 m)
 * de src/lib/parcelle-ingestion.ts par une décision apprise sur plusieurs
 * signaux géométriques.
 *
 * Étiquette : faible supervision, pas une vérité terrain. Une ligne est
 * "positive" si une majorité de ses sommets tombent à moins de --tolerance
 * mètres du contour d'une parcelle du résultat final (donc plausiblement une
 * vraie limite ayant contribué au dessin), "négative" sinon (probable artefact
 * de tracé, ou limite dans une zone où la polygonisation a échoué/produit une
 * autre géométrie). À vérifier avant de faire confiance aveuglément au modèle.
 *
 * Usage : npx tsx scripts/export-line-features.ts <chemin.dxf> <analysisId> [outCsv] [--tolerance=1] [--limit=0]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { PrismaClient } from "@prisma/client";
import proj4 from "proj4";
import { readDxfWorldFeatures } from "../src/lib/dxf-native";
import { filterDxfCadastralFeatures } from "../src/lib/cadastral-filter";
import { loadGeoJsonFromKey } from "../src/lib/geo-storage";

// Le DXF est en UTM28N (mètres), le GeoJSON final stocké pour l'analyse est en
// WGS84 (lon/lat, convention GeoJSON) — reprojection nécessaire avant de
// comparer les deux nuages de coordonnées dans l'indexation par grille.
const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";
function wgs84ToUtm28n(lon: number, lat: number): [number, number] {
  return proj4(WGS84, UTM28N, [lon, lat]) as [number, number];
}

function loadEnv() {
  try {
    const txt = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (/^["'].*["']$/.test(val)) val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* pas de .env */
  }
}
loadEnv();

const POLYGONIZABLE_CLASSES = new Set(["limites_parcelles", "limites_tf", "limites_sections", "piscine"]);

const [, , dxfPathArg, analysisIdArg, outCsvArg, ...rest] = process.argv;
if (!dxfPathArg || !analysisIdArg) {
  console.error("Usage : npx tsx scripts/export-line-features.ts <chemin.dxf> <analysisId> [outCsv] [--tolerance=1] [--limit=0]");
  process.exit(1);
}
const dxfPath = resolve(dxfPathArg);
const analysisId = Number(analysisIdArg);
const outCsv = outCsvArg && !outCsvArg.startsWith("--") ? resolve(outCsvArg) : resolve(`ML/data/line-features-${analysisId}.csv`);
const flags = [outCsvArg, ...rest].filter((a): a is string => !!a && a.startsWith("--"));
const flagValue = (name: string, fallback: number): number => {
  const f = flags.find((a) => a.startsWith(`--${name}=`));
  return f ? Number(f.split("=")[1]) : fallback;
};
const TOLERANCE_M = flagValue("tolerance", 1);
const LIMIT = flagValue("limit", 0); // 0 = pas de limite

type Pt = [number, number];
type Ring = number[][];

/** Distance point→segment (mètres, coordonnées planes UTM). */
function pointToSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Grille d'indexation des segments de contour des parcelles finales (même idiome que healUndershoots). */
class SegmentGrid {
  private cellSize: number;
  private cells = new Map<string, Array<[Pt, Pt]>>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`;
  }

  addSegment(a: Pt, b: Pt): void {
    const seg: [Pt, Pt] = [a, b];
    const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
    for (let x = Math.floor(minX / this.cellSize); x <= Math.floor(maxX / this.cellSize); x++) {
      for (let y = Math.floor(minY / this.cellSize); y <= Math.floor(maxY / this.cellSize); y++) {
        const k = `${x}:${y}`;
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(seg);
      }
    }
  }

  /** Plus courte distance point→réseau, en cherchant dans la cellule et ses voisines. */
  nearestDistance(p: Pt): number {
    const cx = Math.floor(p[0] / this.cellSize);
    const cy = Math.floor(p[1] / this.cellSize);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.cells.get(`${cx + dx}:${cy + dy}`);
        if (!arr) continue;
        for (const [a, b] of arr) {
          const d = pointToSegmentDistance(p, a, b);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

function ringSegments(ring: Ring, grid: SegmentGrid): void {
  for (let i = 0; i < ring.length - 1; i++) {
    const a = wgs84ToUtm28n(ring[i][0], ring[i][1]);
    const b = wgs84ToUtm28n(ring[i + 1][0], ring[i + 1][1]);
    grid.addSegment(a, b);
  }
}

function indexPolygonBoundaries(geom: GeoJSON.Geometry, grid: SegmentGrid): void {
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) ringSegments(ring as Ring, grid);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) for (const ring of poly) ringSegments(ring as Ring, grid);
  }
}

interface LineFeatureRow {
  layer_class: string;
  source_entity: string;
  bbox_diagonal_m: number;
  total_length_m: number;
  num_vertices: number;
  num_segments: number;
  min_segment_len_m: number;
  max_segment_len_m: number;
  mean_segment_len_m: number;
  straightness: number;
  closes_near_start: 0 | 1;
  dist_to_final_boundary_m: number;
  label: 0 | 1;
}

function lineFeatures(coords: Ring): Omit<LineFeatureRow, "layer_class" | "source_entity" | "dist_to_final_boundary_m" | "label"> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let totalLen = 0, minSeg = Infinity, maxSeg = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = coords[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (i > 0) {
      const d = Math.hypot(x - coords[i - 1][0], y - coords[i - 1][1]);
      totalLen += d;
      if (d < minSeg) minSeg = d;
      if (d > maxSeg) maxSeg = d;
    }
  }
  const bboxDiag = Math.hypot(maxX - minX, maxY - minY);
  const numSegments = coords.length - 1;
  const first = coords[0], last = coords[coords.length - 1];
  const closesNearStart = Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1 ? 1 : 0;
  return {
    bbox_diagonal_m: bboxDiag,
    total_length_m: totalLen,
    num_vertices: coords.length,
    num_segments: numSegments,
    min_segment_len_m: minSeg === Infinity ? 0 : minSeg,
    max_segment_len_m: maxSeg,
    mean_segment_len_m: numSegments > 0 ? totalLen / numSegments : 0,
    straightness: totalLen > 0 ? Math.min(1, bboxDiag / totalLen) : 0,
    closes_near_start: closesNearStart,
  };
}

async function main() {
  console.log(`[export-line-features] DXF : ${dxfPath}`);
  const buf = readFileSync(dxfPath);
  const fc = readDxfWorldFeatures(buf);
  console.log(`[export-line-features] Entités lues : ${fc.features.length}`);

  const classified = filterDxfCadastralFeatures(
    fc as unknown as Parameters<typeof filterDxfCadastralFeatures>[0],
    { maxFeatures: null },
  );

  const candidates: { coords: Ring; layerClass: string; sourceEntity: string }[] = [];
  for (const feat of classified.features) {
    const cls = String(feat.properties?._dgid_layer_class ?? "");
    if (!POLYGONIZABLE_CLASSES.has(cls)) continue;
    const geom = feat.geometry;
    if (!geom) continue;
    const sourceEntity = String(feat.properties?._dgid_source_entity ?? "INCONNU");
    if (geom.type === "LineString") {
      candidates.push({ coords: geom.coordinates as Ring, layerClass: cls, sourceEntity });
    } else if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates as unknown as Ring[]) {
        candidates.push({ coords: line, layerClass: cls, sourceEntity });
      }
    }
  }
  console.log(`[export-line-features] Polylignes candidates (avant tout seuil) : ${candidates.length}`);

  const prisma = new PrismaClient();
  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) {
    console.error(`Analyse #${analysisId} introuvable.`);
    process.exit(1);
  }
  const geojsonText = await loadGeoJsonFromKey(analysis.geojsonKey ?? analysis.geojsonUrl ?? null);
  await prisma.$disconnect();
  if (!geojsonText) {
    console.error(`GeoJSON introuvable pour l'analyse #${analysisId} (geojsonKey=${analysis.geojsonKey}).`);
    process.exit(1);
  }
  const finalFc = JSON.parse(geojsonText) as GeoJSON.FeatureCollection;
  console.log(`[export-line-features] Parcelles finales chargées : ${finalFc.features.length}`);

  console.log(`[export-line-features] Indexation des contours finaux (grille ${TOLERANCE_M * 4}m)...`);
  const grid = new SegmentGrid(Math.max(TOLERANCE_M * 4, 10));
  for (const f of finalFc.features) {
    if (f.geometry) indexPolygonBoundaries(f.geometry, grid);
  }

  const pool = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
  const rows: LineFeatureRow[] = [];
  let done = 0;
  for (const { coords, layerClass, sourceEntity } of pool) {
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const feats = lineFeatures(coords);
    // Échantillonne au plus 8 sommets répartis sur la ligne pour rester rapide
    // sur les polylignes à beaucoup de sommets.
    const step = Math.max(1, Math.floor(coords.length / 8));
    const sampled: Pt[] = [];
    for (let i = 0; i < coords.length; i += step) sampled.push(coords[i] as Pt);
    const dists = sampled.map((p) => grid.nearestDistance(p));
    const distToBoundary = dists.reduce((a, b) => a + b, 0) / dists.length;
    const label: 0 | 1 = dists.filter((d) => d <= TOLERANCE_M).length >= Math.ceil(dists.length / 2) ? 1 : 0;
    rows.push({ layer_class: layerClass, source_entity: sourceEntity, ...feats, dist_to_final_boundary_m: distToBoundary, label });
    done++;
    if (done % 20000 === 0) console.log(`[export-line-features] ${done}/${pool.length} lignes traitées...`);
  }

  const header = [
    "layer_class", "source_entity", "bbox_diagonal_m", "total_length_m", "num_vertices", "num_segments",
    "min_segment_len_m", "max_segment_len_m", "mean_segment_len_m", "straightness",
    "closes_near_start", "dist_to_final_boundary_m", "label",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map((h) => String((r as unknown as Record<string, unknown>)[h])).join(","));
  }
  mkdirSync(dirname(outCsv), { recursive: true });
  writeFileSync(outCsv, lines.join("\n"), "utf8");
  const positives = rows.filter((r) => r.label === 1).length;
  console.log(`[export-line-features] ${rows.length} lignes exportées → ${outCsv}`);
  console.log(`[export-line-features] label=1 (contribue au contour final) : ${positives} (${((positives / rows.length) * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
