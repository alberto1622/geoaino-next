/**
 * Génère une visualisation HTML (SVG pan/zoom autonome) du dump produit par
 * diagnose-017-020.ts : face fusionnée, lignes limite_section, libellés,
 * extrémités pendantes.
 * Usage : npx tsx scripts/render-dump-017-020.ts [dump.json] [out.html]
 */
import * as fs from "fs";

const dumpPath = process.argv[2] || "scripts/dump-017-020.json";
const outPath = process.argv[3] || "scripts/dump-017-020.html";

interface Dump {
  face: GeoJSON.Polygon;
  bbox: [number, number, number, number];
  lines: number[][][];
  labels: Array<{ point: [number, number]; num: string }>;
  dangles: Array<{ x: number; y: number; d: number }>;
}

const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as Dump;
const [w, s, e, n] = dump.bbox;
const M = 80;
const W = e - w + 2 * M;
const H = n - s + 2 * M;
// SVG : y vers le bas → on inverse (Y = n + M - y).
const sx = (x: number) => (x - w + M).toFixed(2);
const sy = (y: number) => (n + M - y).toFixed(2);

const facePath = dump.face.coordinates
  .map((ring) => "M" + ring.map(([x, y]) => `${sx(x)},${sy(y)}`).join("L") + "Z")
  .join(" ");

const lineEls = dump.lines
  .map((line) => {
    const pts = line.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ");
    const p0 = line[0];
    const p1 = line[line.length - 1];
    return (
      `<polyline points="${pts}" fill="none" stroke="#7c3aed" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
      `<circle cx="${sx(p0[0])}" cy="${sy(p0[1])}" r="4" fill="#22c55e"/>` +
      `<circle cx="${sx(p1[0])}" cy="${sy(p1[1])}" r="4" fill="#22c55e"/>`
    );
  })
  .join("\n");

const labelEls = dump.labels
  .map(
    (l) =>
      `<circle cx="${sx(l.point[0])}" cy="${sy(l.point[1])}" r="7" fill="#0ea5e9"/>` +
      `<text x="${sx(l.point[0])}" y="${(Number(sy(l.point[1])) - 12).toFixed(2)}" font-size="28" font-weight="700" fill="#0369a1" text-anchor="middle">${l.num}</text>`
  )
  .join("\n");

const dangleEls = dump.dangles
  .map(
    (d) =>
      `<circle cx="${sx(d.x)}" cy="${sy(d.y)}" r="10" fill="none" stroke="#ef4444" stroke-width="3" vector-effect="non-scaling-stroke"/>` +
      `<text x="${sx(d.x)}" y="${(Number(sy(d.y)) - 14).toFixed(2)}" font-size="24" fill="#dc2626" text-anchor="middle">${d.d.toFixed(1)} m</text>`
  )
  .join("\n");

const html = `<title>Diagnostic sections 017/020 — DYA/SIBASSOR (Kaolack)</title>
<style>
  body { margin: 0; font: 13px system-ui, sans-serif; }
  header { padding: 8px 14px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }
  #wrap { width: 100vw; height: calc(100vh - 44px); overflow: hidden; cursor: grab; }
  svg { width: 100%; height: 100%; display: block; }
</style>
<header>
  <strong>Face fusionnée {017, 020}</strong>
  <span><span class="sw" style="background:#fca5a5"></span>face polygonisée</span>
  <span><span class="sw" style="background:#7c3aed"></span>lignes limite_section</span>
  <span><span class="sw" style="background:#22c55e"></span>extrémités de lignes</span>
  <span><span class="sw" style="background:#0ea5e9"></span>libellés numero_section</span>
  <span><span class="sw" style="background:#ef4444"></span>pendantes (trou)</span>
  <span style="color:#666">molette = zoom · glisser = déplacer</span>
</header>
<div id="wrap">
<svg id="map" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" preserveAspectRatio="xMidYMid meet">
  <path d="${facePath}" fill="#fca5a5" fill-opacity="0.35" stroke="#dc2626" stroke-width="1" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>
  ${lineEls}
  ${labelEls}
  ${dangleEls}
</svg>
</div>
<script>
const svg = document.getElementById("map");
const wrap = document.getElementById("wrap");
let vb = { x: 0, y: 0, w: ${W.toFixed(0)}, h: ${H.toFixed(0)} };
const apply = () => svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
wrap.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const k = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
  const r = svg.getBoundingClientRect();
  const mx = vb.x + ((ev.clientX - r.left) / r.width) * vb.w;
  const my = vb.y + ((ev.clientY - r.top) / r.height) * vb.h;
  vb = { x: mx - (mx - vb.x) * k, y: my - (my - vb.y) * k, w: vb.w * k, h: vb.h * k };
  apply();
}, { passive: false });
let drag = null;
wrap.addEventListener("mousedown", (ev) => { drag = { x: ev.clientX, y: ev.clientY }; });
window.addEventListener("mouseup", () => { drag = null; });
window.addEventListener("mousemove", (ev) => {
  if (!drag) return;
  const r = svg.getBoundingClientRect();
  vb.x -= ((ev.clientX - drag.x) / r.width) * vb.w;
  vb.y -= ((ev.clientY - drag.y) / r.height) * vb.h;
  drag = { x: ev.clientX, y: ev.clientY };
  apply();
});
</script>`;

fs.writeFileSync(outPath, html);
console.log(`Visualisation écrite : ${outPath}`);
