/**
 * dxf-native.ts
 *
 * Lecteur DXF natif (sans GDAL) résolvant les BLOCS (entités `INSERT`).
 *
 * Motivation : les DXF issus d'une conversion DGN/Microstation encapsulent la
 * géométrie cadastrale dans des blocs anonymes (`*U…`), en coordonnées locales,
 * insérés en espace modèle. Le driver DXF de GDAL ne déplie pas correctement
 * ces blocs imbriqués → les parcelles n'arrivent jamais dans le GeoJSON
 * (seulement des stubs). Ce parseur :
 *   1. lit les paires (code, valeur) du DXF ;
 *   2. indexe les définitions de blocs (point de base + entités) ;
 *   3. déplie récursivement les `INSERT` de l'espace modèle en appliquant la
 *      transformée (translation + échelle + rotation) → coordonnées monde ;
 *   4. émet une FeatureCollection (assignée EPSG:32628, comme l'export ODA :
 *      le dessin est déjà en mètres UTM28N, aucune reprojection).
 *
 * Le calque effectif suit la règle DXF : une sous-entité sur le calque "0"
 * hérite du calque de l'`INSERT`, sinon conserve son propre calque.
 *
 * Les limites dessinées en segments séparés restent des LineString : elles
 * sont polygonisées en aval (cf. `polygonize.ts`, `parcelle-ingestion.ts`).
 */

type Pair = [string, string];
type Pt = [number, number];

interface RawEntity {
  type: string;
  layer: string | null;
  // géométrie locale (avant transformée du bloc)
  verts: Pt[];
  closed: boolean;
  text: string | null;
  // INSERT
  blockName: string | null;
  insert: Pt;
  scale: [number, number];
  rotation: number; // radians
  // ARC / CIRCLE : centre = verts[0], rayon = radius, angles en degrés (CIRCLE
  // = arc complet 0→360). ELLIPSE : centre = verts[0], grand axe = major (relatif
  // au centre), ratio petit/grand = ratio, paramètres start/end en radians.
  radius: number | null;
  angleStart: number | null;
  angleEnd: number | null;
  major: Pt | null;
  ratio: number | null;
  // LWPOLYLINE : facteur de renflement (bulge) par sommet (arc entre ce sommet et
  // le suivant). Aligné sur `verts` ; 0 = segment droit.
  bulges: number[];
}

interface BlockDef {
  base: Pt;
  entities: RawEntity[];
}

const MAX_BLOCK_DEPTH = 16;

// ───────────────────────────── Tokenisation ─────────────────────────────

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  // DXF = suite de paires (code sur une ligne, valeur sur la suivante).
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([lines[i].trim(), lines[i + 1]]);
  }
  return pairs;
}

function sectionRange(pairs: Pair[], name: string): [number, number] {
  let start = -1;
  let end = -1;
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i][0] === "0" && pairs[i][1].trim() === "SECTION" && pairs[i + 1][0] === "2" && pairs[i + 1][1].trim() === name) {
      start = i + 2;
    }
    if (start >= 0 && pairs[i][0] === "0" && pairs[i][1].trim() === "ENDSEC" && i > start) {
      end = i;
      break;
    }
  }
  return [start, end];
}

// ───────────────────────────── Parsing des entités ─────────────────────────────

function newEntity(type: string): RawEntity {
  return {
    type,
    layer: null,
    verts: [],
    closed: false,
    text: null,
    blockName: null,
    insert: [0, 0],
    scale: [1, 1],
    rotation: 0,
    radius: null,
    angleStart: null,
    angleEnd: null,
    major: null,
    ratio: null,
    bulges: [],
  };
}

/**
 * Parse une plage de paires en liste d'entités. Gère les POLYLINE/VERTEX/SEQEND
 * (anciennes polylignes dont les sommets sont des entités VERTEX séparées).
 */
function parseEntities(pairs: Pair[], start: number, end: number): RawEntity[] {
  const ents: RawEntity[] = [];
  let i = start;
  let pendingPolyline: RawEntity | null = null;
  let mtextChunks: string[] = [];

  while (i < end) {
    if (pairs[i][0] !== "0") {
      i++;
      continue;
    }
    const type = pairs[i][1].trim();
    let j = i + 1;
    const groups: Pair[] = [];
    while (j < end && pairs[j][0] !== "0") {
      groups.push(pairs[j]);
      j++;
    }
    i = j;

    if (type === "ENDBLK") continue;

    if (type === "VERTEX") {
      if (pendingPolyline) {
        let vx: number | null = null;
        let vy: number | null = null;
        let vb = 0;
        for (const [c, v] of groups) {
          if (c === "10") vx = parseFloat(v);
          else if (c === "20") vy = parseFloat(v);
          else if (c === "42") vb = parseFloat(v); // renflement (arc) du sommet
        }
        if (vx != null && vy != null) {
          pendingPolyline.bulges[pendingPolyline.verts.length] = vb;
          pendingPolyline.verts.push([vx, vy]);
        }
      }
      continue;
    }
    if (type === "SEQEND") {
      if (pendingPolyline) {
        ents.push(pendingPolyline);
        pendingPolyline = null;
      }
      continue;
    }

    const e = newEntity(type);
    mtextChunks = [];
    let curX: number | null = null;
    let endX: number | null = null;

    for (const [c, v] of groups) {
      switch (c) {
        case "8":
          e.layer = v.trim();
          break;
        case "2":
          e.blockName = v.trim();
          break;
        case "1":
          e.text = (e.text ?? "") + v;
          break;
        case "3":
          mtextChunks.push(v);
          break;
        case "70":
          e.closed = (parseInt(v, 10) & 1) === 1;
          break;
        case "10":
          curX = parseFloat(v);
          if (type === "INSERT") e.insert[0] = curX;
          else if (type !== "LINE") e.verts.push([curX, NaN]);
          break;
        case "20":
          if (type === "INSERT") e.insert[1] = parseFloat(v);
          else if (type === "LINE") e.verts[0] = [curX ?? 0, parseFloat(v)];
          else if (e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          break;
        case "11":
          endX = parseFloat(v);
          // 3DFACE/SOLID : 2ᵉ sommet (codes 11/21, 12/22, 13/23 = coins 2 à 4).
          // ELLIPSE : extrémité du grand axe (relative au centre).
          if (type === "3DFACE" || type === "SOLID") e.verts.push([endX, NaN]);
          else if (type === "ELLIPSE") e.major = [endX, NaN];
          break;
        case "21":
          if (type === "LINE") e.verts[1] = [endX ?? 0, parseFloat(v)];
          else if ((type === "3DFACE" || type === "SOLID") && e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          else if (type === "ELLIPSE" && e.major) e.major[1] = parseFloat(v);
          break;
        case "12":
          if (type === "3DFACE" || type === "SOLID") e.verts.push([parseFloat(v), NaN]);
          break;
        case "22":
          if ((type === "3DFACE" || type === "SOLID") && e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          break;
        case "13":
          if (type === "3DFACE" || type === "SOLID") e.verts.push([parseFloat(v), NaN]);
          break;
        case "23":
          if ((type === "3DFACE" || type === "SOLID") && e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          break;
        case "40":
          // Rayon (ARC/CIRCLE) ou ratio petit/grand axe (ELLIPSE). Pour les autres
          // types (LWPOLYLINE = largeur de départ…), on ignore.
          if (type === "ARC" || type === "CIRCLE") e.radius = parseFloat(v);
          else if (type === "ELLIPSE") e.ratio = parseFloat(v);
          break;
        case "41":
          if (type === "INSERT") e.scale[0] = parseFloat(v) || 1;
          else if (type === "ELLIPSE") e.angleStart = parseFloat(v); // paramètre (radians)
          break;
        case "42":
          if (type === "INSERT") e.scale[1] = parseFloat(v) || 1;
          else if (type === "ELLIPSE") e.angleEnd = parseFloat(v); // paramètre (radians)
          // Renflement (bulge) du sommet courant d'une LWPOLYLINE (arc jusqu'au
          // sommet suivant). Aligné sur le dernier sommet lu.
          else if (type === "LWPOLYLINE" && e.verts.length) e.bulges[e.verts.length - 1] = parseFloat(v);
          break;
        case "50":
          if (type === "INSERT") e.rotation = (parseFloat(v) || 0) * (Math.PI / 180);
          else if (type === "ARC") e.angleStart = parseFloat(v); // degrés
          break;
        case "51":
          if (type === "ARC") e.angleEnd = parseFloat(v); // degrés
          break;
      }
    }

    if (type === "MTEXT" && mtextChunks.length) {
      e.text = mtextChunks.join("") + (e.text ?? "");
    }

    if (type === "POLYLINE") {
      // Les sommets arrivent ensuite via des entités VERTEX.
      pendingPolyline = e;
      continue;
    }

    ents.push(e);
  }

  if (pendingPolyline) ents.push(pendingPolyline);
  return ents;
}

function parseBlocks(pairs: Pair[], start: number, end: number): Record<string, BlockDef> {
  const blocks: Record<string, BlockDef> = {};
  let i = start;
  while (i < end) {
    if (pairs[i][0] === "0" && pairs[i][1].trim() === "BLOCK") {
      let j = i + 1;
      let name: string | null = null;
      const base: Pt = [0, 0];
      while (j < end && pairs[j][0] !== "0") {
        const [c, v] = pairs[j];
        if (c === "2") name = v.trim();
        else if (c === "10") base[0] = parseFloat(v);
        else if (c === "20") base[1] = parseFloat(v);
        j++;
      }
      let k = j;
      while (k < end && !(pairs[k][0] === "0" && pairs[k][1].trim() === "ENDBLK")) k++;
      if (name) blocks[name] = { base, entities: parseEntities(pairs, j, k) };
      i = k + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

// ───────────────────────────── Transformée des blocs ─────────────────────────────

type TransformFn = (p: Pt) => Pt;

function insertTransform(base: Pt, insert: Pt, scale: [number, number], rotation: number): TransformFn {
  const cr = Math.cos(rotation);
  const sr = Math.sin(rotation);
  return ([px, py]: Pt): Pt => {
    const x = (px - base[0]) * scale[0];
    const y = (py - base[1]) * scale[1];
    return [x * cr - y * sr + insert[0], x * sr + y * cr + insert[1]];
  };
}

// ───────────────────────────── Émission des features ─────────────────────────────

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;

/**
 * Recensement des entités (réconciliation anti-perte silencieuse) : par type,
 * combien ont été lues, émises (géométrie produite) ou écartées, avec le motif.
 * `entrée = émises + écartées` doit toujours tenir — toute entité non émise est
 * ainsi VISIBLE (journalisée) plutôt que perdue en silence.
 */
export interface Census {
  seen: Record<string, number>;
  emitted: Record<string, number>;
  skipped: Record<string, number>; // type → nombre écarté
  skipReasons: Record<string, number>; // motif → nombre
}

function newCensus(): Census {
  return { seen: {}, emitted: {}, skipped: {}, skipReasons: {} };
}

function bump(rec: Record<string, number>, key: string, n = 1): void {
  rec[key] = (rec[key] || 0) + n;
}

function effectiveLayer(entityLayer: string | null, parentLayer: string | null): string {
  if (!entityLayer || entityLayer === "0") return parentLayer ?? "0";
  return entityLayer;
}

/**
 * Nettoie les codes de formatage inline MTEXT (AutoCAD/Microstation/ODA) d'un
 * texte. Un MTEXT encode la mise en forme dans le contenu même :
 *   `\fArial Black|b0|i0|c00|p39;ZAR/948` → police + `ZAR/948`.
 * On retire ces codes pour ne garder que le texte lisible :
 *   - police `\f...;` / `\F...;`, couleur `\C...;`/`\c...;`, hauteur `\H...;`,
 *     alignement `\A...;`, largeur `\W...;`, oblique `\Q...;`, interligne `\p...;`,
 *     interlettrage `\T...;` (argument terminé par `;`) ;
 *   - empilement de fractions `\S num ^ den ;` → `num/den` ;
 *   - bascules de style sans argument `\L \l \O \o \K \k` ;
 *   - accolades de groupement `{ }` ;
 *   - saut de paragraphe `\P` → retour à la ligne, espace insécable `\~` → espace ;
 *   - échappements littéraux `\\`, `\{`, `\}` → `\`, `{`, `}`.
 */
export function decodeMText(raw: string): string {
  if (!raw) return "";
  // Sentinelles (caractères Unicode réservés, absents des textes DXF) protégeant
  // les échappements littéraux \\ \{ \} pendant le nettoyage des codes.
  const BSL = "￹";
  const LBR = "￺";
  const RBR = "￻";
  let s = raw;
  s = s.replace(/\\\\/g, BSL).replace(/\\\{/g, LBR).replace(/\\\}/g, RBR);
  // Sauts de paragraphe/ligne et espace insécable.
  s = s.replace(/\\P/g, "\n").replace(/\\~/g, " ");
  // Empilement (fractions) : garde le contenu, sépare par « / ».
  s = s.replace(/\\S([^;]*);/g, (_m, g: string) => g.replace(/[#^]/g, "/"));
  // Codes de formatage avec argument terminé par « ; » (police, couleur,
  // hauteur, alignement, largeur, oblique, interligne, interlettrage).
  s = s.replace(/\\[fFcCAHWQTp][^;]*;/g, "");
  // Bascules de style sans argument (soulignement/surlignage/barré).
  s = s.replace(/\\[LlOoKk]/g, "");
  // Accolades de groupement.
  s = s.replace(/[{}]/g, "");
  // Restaure les échappements littéraux.
  s = s.split(BSL).join("\\").split(LBR).join("{").split(RBR).join("}");
  return s;
}

// ───────────────────────────── Densification des courbes ─────────────────────────────
//
// Les bords de parcelle courbes (ARC, renflement de polyligne, CIRCLE, ELLIPSE,
// SPLINE) doivent devenir des polylignes pour se refermer avec les segments
// droits voisins lors de la polygonisation : sinon la parcelle porteuse d'un arc
// reste ouverte → perdue. On échantillonne chaque courbe en petits segments
// (pas ≈ 3°, borné) — précision cadastrale largement suffisante, volume maîtrisé.

const ARC_MAX_SEGMENTS = 64;
const ARC_DEG_STEP = 3;

/** Nombre de segments pour un balayage d'angle donné (radians), borné. */
function arcSegments(sweepRad: number): number {
  const deg = Math.abs(sweepRad) * (180 / Math.PI);
  return Math.max(4, Math.min(ARC_MAX_SEGMENTS, Math.ceil(deg / ARC_DEG_STEP)));
}

/** Points d'un arc de centre (cx,cy), rayon r, de a0 à a1 (radians, sens CCW). */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 2 * Math.PI; // sens trigonométrique (CCW)
  const n = arcSegments(sweep);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * Densifie un arc défini par un renflement (bulge) DXF entre p1 et p2.
 * bulge = tan(θ/4), θ = angle au centre (signe = sens). Retourne les points
 * INTERMÉDIAIRES (p1 et p2 exclus, ajoutés par l'appelant).
 */
function bulgePoints(p1: Pt, p2: Pt, bulge: number): Pt[] {
  if (!bulge) return [];
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return [];
  const theta = 4 * Math.atan(bulge); // angle au centre (signé)
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // Centre = milieu de la corde décalé de la sagitta, perpendiculairement.
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const d = r * Math.cos(Math.abs(theta) / 2);
  const sign = bulge > 0 ? 1 : -1; // arc à gauche (CCW) si bulge > 0
  const ux = -dy / chord, uy = dx / chord;
  const cx = mx + sign * ux * d, cy = my + sign * uy * d;
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = arcSegments(theta);
  const pts: Pt[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Développe une polyligne en insérant les arcs de renflement entre sommets. */
function densifyPolyline(verts: Pt[], bulges: number[], closed: boolean): Pt[] {
  const src = closed && verts.length >= 3 ? [...verts, verts[0]] : verts;
  const out: Pt[] = [];
  for (let i = 0; i < src.length; i++) {
    out.push(src[i]);
    if (i < src.length - 1) {
      const b = bulges[i] || 0;
      if (b) out.push(...bulgePoints(src[i], src[i + 1], b));
    }
  }
  return out;
}

/** Points d'une ellipse (centre c, grand axe `major` relatif à c, ratio, params). */
function ellipsePoints(c: Pt, major: Pt, ratio: number, p0: number, p1: number): Pt[] {
  const ax = major[0], ay = major[1];
  const a = Math.hypot(ax, ay);
  const b = a * (ratio || 1);
  const rot = Math.atan2(ay, ax);
  let sweep = p1 - p0;
  if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI; // ellipse complète
  while (sweep <= 0) sweep += 2 * Math.PI;
  const n = arcSegments(sweep);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = p0 + (sweep * i) / n;
    const ex = a * Math.cos(t), ey = b * Math.sin(t);
    pts.push([c[0] + ex * cos - ey * sin, c[1] + ex * sin + ey * cos]);
  }
  return pts;
}

function emitGeometryFeatures(
  entities: RawEntity[],
  blocks: Record<string, BlockDef>,
  xform: TransformFn,
  depth: number,
  parentLayer: string | null,
  out: Feature[],
  census?: Census
): void {
  if (depth > MAX_BLOCK_DEPTH) return;

  for (const e of entities) {
    const layer = effectiveLayer(e.layer, parentLayer);
    if (census) bump(census.seen, e.type);

    // Émission comptabilisée (réconciliation) + repli sur « écarté + motif ».
    const emit = (geometry: GeoJSON.Geometry): void => {
      out.push({ type: "Feature", geometry, properties: { Layer: layer } });
      if (census) bump(census.emitted, e.type);
    };
    const emitText = (text: string, pt: Pt): void => {
      out.push({ type: "Feature", geometry: { type: "Point", coordinates: pt }, properties: { Layer: layer, Text: text } });
      if (census) bump(census.emitted, e.type);
    };
    const skip = (reason: string): void => {
      if (census) { bump(census.skipped, e.type); bump(census.skipReasons, reason); }
    };

    if (e.type === "INSERT") {
      const blk = e.blockName ? blocks[e.blockName] : undefined;
      if (!blk) { skip("insert_bloc_introuvable"); continue; }
      const local = insertTransform(blk.base, e.insert, e.scale, e.rotation);
      const composed: TransformFn = (p) => xform(local(p));
      emitGeometryFeatures(blk.entities, blocks, composed, depth + 1, layer, out, census);
      continue;
    }

    // ATTRIB = valeur d'attribut d'un bloc inséré (souvent un numéro/libellé réel) :
    // à émettre comme texte pour ne pas la perdre. ATTDEF (gabarit d'attribut dans
    // la définition de bloc) reste écarté : c'est une invite, pas une donnée.
    if (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") {
      const pt = e.verts[0];
      if (!pt || pt.some((n) => !Number.isFinite(n))) { skip("texte_sans_point"); continue; }
      const text = decodeMText(e.text ?? "").trim();
      if (!text) { skip("texte_vide"); continue; }
      emitText(text, xform(pt));
      continue;
    }

    if (e.type === "POINT") {
      const pt = e.verts[0];
      if (!pt || pt.some((n) => !Number.isFinite(n))) { skip("point_invalide"); continue; }
      emit({ type: "Point", coordinates: xform(pt) });
      continue;
    }

    if (e.type === "3DFACE" || e.type === "SOLID") {
      // Faces/quadrilatères pleins : parcelles/emprises dessinées en surface.
      // SOLID stocke ses coins dans l'ordre 1-2-4-3 (le 3ᵉ et le 4ᵉ sont
      // permutés vs le sens du contour) : on réordonne avant de fermer l'anneau.
      let verts = e.verts.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (e.type === "SOLID" && verts.length === 4) verts = [verts[0], verts[1], verts[3], verts[2]];
      if (verts.length < 3) { skip("face_moins_3_sommets"); continue; }
      const world = verts.map(xform);
      const ring: Pt[] = [];
      for (const p of world) {
        const prev = ring[ring.length - 1];
        if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) ring.push(p);
      }
      if (ring.length < 3) { skip("face_degeneree"); continue; }
      ring.push(ring[0]);
      emit({ type: "Polygon", coordinates: [ring] });
      continue;
    }

    if (e.type === "LINE" || e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      // Densifie d'abord les arcs de renflement (bulge) pour que les bords courbes
      // se referment avec les segments droits voisins à la polygonisation.
      const densified = densifyPolyline(e.verts, e.bulges, e.closed);
      const verts = densified.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (verts.length < 2) { skip("polyligne_moins_2_sommets"); continue; }
      const world = verts.map(xform);
      if (e.closed && world.length >= 3) {
        emit({ type: "Polygon", coordinates: [[...world, world[0]]] });
      } else {
        emit({ type: "LineString", coordinates: world });
      }
      continue;
    }

    if (e.type === "ARC") {
      // Bord de parcelle courbe : sans densification, l'anneau reste ouvert →
      // parcelle perdue. Centre = verts[0], angles en degrés (sens CCW).
      const c = e.verts[0];
      if (!c || e.radius == null || e.angleStart == null || e.angleEnd == null || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
        skip("arc_incomplet"); continue;
      }
      const pts = arcPoints(c[0], c[1], e.radius, e.angleStart * Math.PI / 180, e.angleEnd * Math.PI / 180);
      if (pts.length < 2) { skip("arc_degenere"); continue; }
      emit({ type: "LineString", coordinates: pts.map(xform) });
      continue;
    }

    if (e.type === "CIRCLE") {
      const c = e.verts[0];
      if (!c || e.radius == null || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) { skip("cercle_incomplet"); continue; }
      const pts = arcPoints(c[0], c[1], e.radius, 0, 2 * Math.PI);
      emit({ type: "Polygon", coordinates: [pts.map(xform)] });
      continue;
    }

    if (e.type === "ELLIPSE") {
      const c = e.verts[0];
      if (!c || !e.major || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) { skip("ellipse_incomplete"); continue; }
      const p0 = e.angleStart ?? 0;
      const p1 = e.angleEnd ?? 2 * Math.PI;
      const pts = ellipsePoints(c, e.major, e.ratio ?? 1, p0, p1);
      const closed = Math.abs((p1 - p0) - 2 * Math.PI) < 1e-6 || Math.abs(p1 - p0) < 1e-9;
      emit(closed
        ? { type: "Polygon", coordinates: [pts.map(xform)] }
        : { type: "LineString", coordinates: pts.map(xform) });
      continue;
    }

    if (e.type === "SPLINE") {
      // Approximation : polyligne par les points de contrôle (verts, code 10).
      // Grossier mais évite de perdre un bord courbe ; la polygonisation ferme le
      // reste. Une SPLINE fermée (bit 1 du drapeau 70) devient un anneau.
      const verts = e.verts.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (verts.length < 2) { skip("spline_moins_2_points"); continue; }
      const world = verts.map(xform);
      emit(e.closed && world.length >= 3
        ? { type: "Polygon", coordinates: [[...world, world[0]]] }
        : { type: "LineString", coordinates: world });
      continue;
    }

    // Tout autre type (HATCH, MESH, …) : non émis mais COMPTÉ (jamais silencieux).
    // Les parcelles remplies par HATCH ont quasi toujours leur contour aussi
    // dessiné en segments (LINE) → récupérées par ailleurs ; la réconciliation
    // rend visible toute exception.
    skip(`type_non_gere_${e.type.toLowerCase()}`);
  }
}

// ───────────────────────────── API ─────────────────────────────

const IDENTITY: TransformFn = (p) => p;

/**
 * Lit un DXF (Buffer) et retourne toutes les entités géométriques en
 * coordonnées monde (EPSG:32628), blocs dépliés. Lève une erreur si le DXF
 * ne contient pas de section ENTITIES exploitable.
 */
/** FeatureCollection enrichie du recensement de réconciliation (anti-perte). */
export type DxfFeatureCollection = GeoJSON.FeatureCollection & { _census?: Census };

/** Journalise la réconciliation entrée/émis/écarté (visibilité des pertes). */
function logCensus(census: Census): void {
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  const totalSeen = sum(census.seen);
  const totalEmitted = sum(census.emitted);
  const totalSkipped = sum(census.skipped);
  // Types géométriques écartés portant potentiellement des limites de parcelle.
  const skippedByType = Object.entries(census.skipped)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  console.log(
    "[dxf-native] Réconciliation:",
    JSON.stringify({
      seen: census.seen,
      emitted: census.emitted,
      totalSeen,
      totalEmitted,
      totalSkipped,
      skippedByType: Object.fromEntries(skippedByType),
      skipReasons: census.skipReasons,
    })
  );
  if (totalSkipped > 0) {
    console.warn(
      `[dxf-native] ${totalSkipped} entité(s) non émise(s) — voir skipReasons. ` +
      `Aucune perte silencieuse : chaque motif est comptabilisé.`
    );
  }
}

export function readDxfWorldFeatures(buffer: Buffer): DxfFeatureCollection {
  // UTF-8 : les exports DXF modernes (ODA/AutoCAD R2007+/AC1021+) encodent les
  // noms de calques et textes en UTF-8. Décoder en latin1 mutilait les calques
  // accentués (« Numéros Parcelle » → « NumÃ©ros Parcelle » → non classé, donc
  // aucun numéro de parcelle extrait → NICAD non construits). Les codes de groupe
  // restant ASCII (sous-ensemble d'UTF-8), le parsing géométrique est inchangé ;
  // un fichier réellement latin1 dégrade proprement (octets hauts → U+FFFD, de
  // toute façon retirés par la normalisation des noms de calques).
  const pairs = tokenize(buffer.toString("utf8"));

  const [es, ee] = sectionRange(pairs, "ENTITIES");
  if (es < 0 || ee < 0) {
    throw new Error("DXF natif : section ENTITIES introuvable.");
  }

  const [bs, be] = sectionRange(pairs, "BLOCKS");
  const blocks = bs >= 0 && be >= 0 ? parseBlocks(pairs, bs, be) : {};
  const modelEntities = parseEntities(pairs, es, ee);

  const out: Feature[] = [];
  const census = newCensus();
  emitGeometryFeatures(modelEntities, blocks, IDENTITY, 0, null, out, census);
  logCensus(census);

  return { type: "FeatureCollection", features: out, _census: census };
}
