/**
 * Diagnostic des SECTIONS d'un DXF cadastral : détecte les faces de section
 * contenant PLUSIEURS numéros de section distincts (fusion) et balaie plusieurs
 * tolérances de raccord pour trouver celle qui sépare correctement.
 *
 * Usage : npx tsx scripts/diagnose-sections.ts [chemin.dxf]
 */
import * as fs from "fs";
import * as turf from "@turf/turf";
import { readDxfWorldFeatures } from "../src/lib/dxf-native";
import { filterDxfCadastralFeatures } from "../src/lib/cadastral-filter";
import { polygonizeLines } from "../src/lib/polygonize";
import { normalizeSection } from "../src/lib/nicad";

const file =
  process.argv[2] ||
  "C:/Users/bakho/Desktop/dgig_project/data/PLAN-CADASTRAL_KAOLACK_FINAL_-11-12-2025.dxf";

const inSenegal = (x: number, y: number) =>
  x >= 100000 && x <= 1000000 && y >= 900000 && y <= 2200000;

type Ring = number[][];

function ringClosedOrNull(coords: Ring): Ring | null {
  if (!Array.isArray(coords) || coords.length < 4) return null;
  const f = coords[0];
  const l = coords[coords.length - 1];
  if (f[0] === l[0] && f[1] === l[1]) return coords;
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 0.05) return [...coords.slice(0, -1), [f[0], f[1]]];
  return null;
}

interface Face {
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  area: number;
  bbox: [number, number, number, number];
  source: "authored" | "polygonized";
  labels: Set<string>;
}

function faceOf(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon, source: Face["source"]): Face {
  const f = turf.feature(geom);
  const [w, s, e, n] = turf.bbox(f);
  let area = 0;
  try {
    // Coordonnées planes en mètres : aire du lacet via JSTS serait mieux, mais
    // turf.area suppose des degrés — on calcule le lacet nous-mêmes.
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const rings of polys) {
      const ring = rings[0];
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      area += Math.abs(a / 2);
    }
  } catch { /* ignore */ }
  return { geom, area, bbox: [w, s, e, n], source, labels: new Set() };
}

async function main() {
  const buf = fs.readFileSync(file);
  console.log(`Fichier : ${file} (${(buf.length / 1e6).toFixed(1)} Mo)`);
  const fc = readDxfWorldFeatures(buf);
  console.log(`Entités lues : ${fc.features.length}`);
  const classified = filterDxfCadastralFeatures(
    fc as unknown as Parameters<typeof filterDxfCadastralFeatures>[0],
    { maxFeatures: null },
  );

  const openLines: Ring[] = [];
  const authored: Face[] = [];
  const labels: Array<{ point: [number, number]; num: string }> = [];

  for (const feat of classified.features) {
    const cls = String(feat.properties?._dgid_layer_class ?? "");
    const geom = feat.geometry;
    if (!geom) continue;

    if (cls === "limites_sections") {
      const pushLine = (coords: Ring) => {
        if (!coords.every((c) => inSenegal(c[0], c[1]))) return;
        const ring = ringClosedOrNull(coords);
        if (ring) authored.push(faceOf({ type: "Polygon", coordinates: [ring] }, "authored"));
        else if (coords.length >= 2) openLines.push(coords);
      };
      if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
        authored.push(faceOf(geom as GeoJSON.Polygon | GeoJSON.MultiPolygon, "authored"));
      } else if (geom.type === "LineString") {
        pushLine(geom.coordinates as Ring);
      } else if (geom.type === "MultiLineString") {
        for (const line of geom.coordinates as unknown as Ring[]) pushLine(line);
      }
    } else if (cls === "numero_section") {
      const text = String(feat.properties?.Text ?? feat.properties?.text ?? "").trim();
      const num = normalizeSection(text);
      if (!num) continue;
      const pts: number[][] =
        geom.type === "Point" ? [geom.coordinates as number[]]
        : geom.type === "MultiPoint" ? (geom.coordinates as number[][])
        : [];
      for (const pt of pts) {
        if (pt.length >= 2 && inSenegal(pt[0], pt[1])) labels.push({ point: [pt[0], pt[1]], num });
      }
    }
  }

  console.log(`Lignes ouvertes limites_sections : ${openLines.length}`);
  console.log(`Polygones/anneaux « authored »   : ${authored.length}`);
  console.log(`Libellés numero_section          : ${labels.length} (${new Set(labels.map((l) => l.num)).size} numéros distincts)`);

  // Arêtes des anneaux fermés (authored) : candidates à l'injection dans le
  // réseau — une mitoyenne ouverte ne peut refermer une face que si le contour
  // fermé sur lequel elle s'appuie fait partie du réseau nodé.
  const authoredEdges: Ring[] = [];
  for (const a of authored) {
    const polys = a.geom.type === "Polygon" ? [a.geom.coordinates] : a.geom.coordinates;
    for (const rings of polys) for (const ring of rings) authoredEdges.push(ring as Ring);
  }

  for (const { tol, withAuthored } of [
    { tol: 1, withAuthored: false },
    { tol: 1, withAuthored: true },
    { tol: 2, withAuthored: true },
    { tol: 5, withAuthored: true },
  ]) {
    const network = withAuthored ? [...openLines, ...authoredEdges] : openLines;
    let polygonized: Face[] = [];
    try {
      polygonized = polygonizeLines(network, { minAreaM2: 5, snapToleranceM: tol })
        .map((g) => faceOf(g, "polygonized"));
    } catch (err) {
      console.log(`tol=${tol} m : polygonisation échouée (${err})`);
      continue;
    }

    const faces = [...authored.map((a) => ({ ...a, labels: new Set<string>() })), ...polygonized];

    // Jointure : chaque libellé va au PLUS PETIT polygone qui le contient.
    let orphans = 0;
    for (const lbl of labels) {
      const pt = turf.point(lbl.point);
      let best: Face | null = null;
      for (const face of faces) {
        const [w, s, e, n] = face.bbox;
        if (lbl.point[0] < w || lbl.point[0] > e || lbl.point[1] < s || lbl.point[1] > n) continue;
        try {
          if (!turf.booleanPointInPolygon(pt, turf.feature(face.geom))) continue;
        } catch { continue; }
        if (!best || face.area < best.area) best = face;
      }
      if (best) best.labels.add(lbl.num);
      else orphans++;
    }

    const merged = faces.filter((f) => f.labels.size > 1);
    console.log(
      `\ntol=${tol} m, arêtes authored ${withAuthored ? "INCLUSES" : "exclues"} : ` +
        `${polygonized.length} faces polygonisées, ${merged.length} face(s) multi-numéros, ${orphans} libellé(s) orphelin(s)`
    );
    for (const m of merged.slice(0, 15)) {
      const cx = ((m.bbox[0] + m.bbox[2]) / 2).toFixed(0);
      const cy = ((m.bbox[1] + m.bbox[3]) / 2).toFixed(0);
      console.log(
        `  · [${m.source}] numéros {${[...m.labels].sort().join(", ")}} — centre ~(${cx}, ${cy}) — ${(m.area / 1e4).toFixed(1)} ha`
      );
    }
    const target = merged.find((m) => m.labels.has("017") && m.labels.has("020"));
    if (target) {
      console.log(`  → CAS 017+020 PRÉSENT à tol=${tol} m (source=${target.source})`);
    } else {
      console.log(`  → cas 017+020 : absent (séparées) à tol=${tol} m`);
    }
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
