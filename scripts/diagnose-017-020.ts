/**
 * Diagnostic ciblé : face de section contenant à la fois les numéros 017 et 020
 * (cas SIBASSOR, Kaolack). Analyse le sous-réseau limites_sections autour de la
 * face fusionnée : extrémités pendantes (taille des trous), lignes internes
 * (mitoyenne présente ?), commune (jointure DB).
 *
 * Usage : npx tsx scripts/diagnose-017-020.ts [chemin.dxf]
 */
import * as fs from "fs";
import * as path from "path";
import * as turf from "@turf/turf";
import proj4 from "proj4";
import { readDxfWorldFeatures } from "../src/lib/dxf-native";
import { filterDxfCadastralFeatures } from "../src/lib/cadastral-filter";
import { polygonizeLines } from "../src/lib/polygonize";
import { normalizeSection } from "../src/lib/nicad";

// Charge .env/.env.local (DATABASE_URL) pour la jointure commune (prisma).
for (const envFile of [".env", ".env.local"]) {
  const p = path.join(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const UTM28N = "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs";
const to4326 = (x: number, y: number): [number, number] =>
  proj4(UTM28N, "EPSG:4326", [x, y]) as [number, number];

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

function shoelace(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

async function main() {
  const buf = fs.readFileSync(file);
  const fc = readDxfWorldFeatures(buf);
  const classified = filterDxfCadastralFeatures(
    fc as unknown as Parameters<typeof filterDxfCadastralFeatures>[0],
    { maxFeatures: null },
  );

  const network: Ring[] = []; // lignes ouvertes + arêtes des anneaux fermés
  const labels: Array<{ point: [number, number]; num: string }> = [];

  for (const feat of classified.features) {
    const cls = String(feat.properties?._dgid_layer_class ?? "");
    const geom = feat.geometry;
    if (!geom) continue;
    if (cls === "limites_sections") {
      const push = (coords: Ring) => {
        if (!coords.every((c) => inSenegal(c[0], c[1])) || coords.length < 2) return;
        const ring = ringClosedOrNull(coords);
        network.push(ring ?? coords);
      };
      if (geom.type === "Polygon") for (const r of geom.coordinates) push(r as Ring);
      else if (geom.type === "MultiPolygon")
        for (const p of geom.coordinates) for (const r of p) push(r as Ring);
      else if (geom.type === "LineString") push(geom.coordinates as Ring);
      else if (geom.type === "MultiLineString")
        for (const line of geom.coordinates as unknown as Ring[]) push(line);
    } else if (cls === "numero_section") {
      const text = String(feat.properties?.Text ?? "").trim();
      const num = normalizeSection(text);
      if (!num) continue;
      const pts: number[][] =
        geom.type === "Point" ? [geom.coordinates as number[]]
        : geom.type === "MultiPoint" ? (geom.coordinates as number[][]) : [];
      for (const pt of pts) {
        if (pt.length >= 2 && inSenegal(pt[0], pt[1])) labels.push({ point: [pt[0], pt[1]], num });
      }
    }
  }

  const faces = polygonizeLines(network, { minAreaM2: 5, snapToleranceM: 1 }).map((g) => {
    const bbox = turf.bbox(turf.feature(g)) as [number, number, number, number];
    return { geom: g, bbox, area: shoelace(g.coordinates[0] as Ring), labels: new Set<string>() };
  });

  for (const lbl of labels) {
    let best: (typeof faces)[number] | null = null;
    for (const face of faces) {
      const [w, s, e, n] = face.bbox;
      if (lbl.point[0] < w || lbl.point[0] > e || lbl.point[1] < s || lbl.point[1] > n) continue;
      try {
        if (!turf.booleanPointInPolygon(turf.point(lbl.point), turf.feature(face.geom))) continue;
      } catch { continue; }
      if (!best || face.area < best.area) best = face;
    }
    if (best) best.labels.add(lbl.num);
  }

  const targets = faces.filter((f) => f.labels.has("017") && f.labels.has("020"));
  console.log(`Faces contenant 017 ET 020 : ${targets.length}`);

  for (const face of targets) {
    const [w, s, e, n] = face.bbox;
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    console.log(`\n=== Face fusionnée {${[...face.labels].sort().join(",")}} ===`);
    console.log(`bbox UTM : [${w.toFixed(0)}, ${s.toFixed(0)}] – [${e.toFixed(0)}, ${n.toFixed(0)}] (${(face.area / 1e4).toFixed(1)} ha)`);

    // Commune (jointure DB sur le point représentatif).
    try {
      const { getCommuneInfo2026ForPoints } = await import("../src/lib/cadastre/data");
      const rep = turf.pointOnFeature(turf.feature(face.geom)).geometry.coordinates as [number, number];
      const [lng, lat] = to4326(rep[0], rep[1]);
      const [info] = await getCommuneInfo2026ForPoints([{ lng, lat }]);
      console.log(`Commune : ${info?.nomCommune ?? "?"} (syscol ${info?.syscol ?? "?"}, ${info?.departement ?? "?"})`);
    } catch (err) {
      console.log(`Commune : jointure DB indisponible (${err instanceof Error ? err.message.slice(0, 80) : err})`);
    }

    // Libellés 017/020 dans la face.
    for (const lbl of labels) {
      if ((lbl.num === "017" || lbl.num === "020") &&
          lbl.point[0] >= w && lbl.point[0] <= e && lbl.point[1] >= s && lbl.point[1] <= n) {
        console.log(`  libellé ${lbl.num} @ (${lbl.point[0].toFixed(1)}, ${lbl.point[1].toFixed(1)})`);
      }
    }

    // Sous-réseau : lignes dont la bbox intersecte la face (+50 m).
    const M = 50;
    const sub = network.filter((line) =>
      line.some((c) => c[0] >= w - M && c[0] <= e + M && c[1] >= s - M && c[1] <= n + M)
    );
    console.log(`Sous-réseau : ${sub.length} ligne(s)`);

    // Extrémités pendantes : distance min de chaque extrémité au reste du réseau.
    const dangles: Array<{ x: number; y: number; d: number }> = [];
    for (let i = 0; i < sub.length; i++) {
      const line = sub[i];
      const f0 = line[0];
      const f1 = line[line.length - 1];
      if (f0[0] === f1[0] && f0[1] === f1[1]) continue; // anneau fermé
      for (const [px, py] of [f0, f1]) {
        let dMin = Infinity;
        for (let j = 0; j < sub.length; j++) {
          const other = sub[j];
          for (let k = 0; k < other.length - 1; k++) {
            if (j === i) {
              // ignore les segments incidents à l'extrémité elle-même
              const isFirst = px === f0[0] && py === f0[1];
              if ((isFirst && k === 0) || (!isFirst && k === other.length - 2)) continue;
            }
            const ax = other[k][0], ay = other[k][1];
            const bx = other[k + 1][0], by = other[k + 1][1];
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ax + t * dx, qy = ay + t * dy;
            const d = Math.hypot(px - qx, py - qy);
            if (d < dMin) dMin = d;
          }
        }
        if (dMin > 0.01) dangles.push({ x: px, y: py, d: dMin });
      }
    }
    dangles.sort((a, b) => b.d - a.d);
    console.log(`Extrémités pendantes (> 1 cm du reste) : ${dangles.length}`);
    for (const dg of dangles.slice(0, 25)) {
      const inside = turf.booleanPointInPolygon(turf.point([dg.x, dg.y]), turf.feature(face.geom));
      console.log(`  · (${dg.x.toFixed(1)}, ${dg.y.toFixed(1)}) — trou ${dg.d.toFixed(2)} m ${inside ? "[INTÉRIEUR face]" : ""}`);
    }

    // Dump JSON pour visualisation (face + sous-réseau + libellés + pendantes).
    const dump = {
      face: face.geom,
      bbox: face.bbox,
      lines: sub,
      labels: labels.filter(
        (l) => l.point[0] >= w - M && l.point[0] <= e + M && l.point[1] >= s - M && l.point[1] <= n + M
      ),
      dangles,
    };
    const out = process.argv[3] || "scripts/dump-017-020.json";
    fs.writeFileSync(out, JSON.stringify(dump));
    console.log(`Dump écrit : ${out}`);
  }
}

main().catch((e) => {
  console.error("ÉCHEC:", e);
  process.exit(1);
});
