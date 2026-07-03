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
        for (const [c, v] of groups) {
          if (c === "10") vx = parseFloat(v);
          else if (c === "20") vy = parseFloat(v);
        }
        if (vx != null && vy != null) pendingPolyline.verts.push([vx, vy]);
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
          // 3DFACE : 2ᵉ sommet (les codes 11/21, 12/22, 13/23 portent les
          // coins 2 à 4 de la face, dans l'ordre du contour).
          if (type === "3DFACE") e.verts.push([endX, NaN]);
          break;
        case "21":
          if (type === "LINE") e.verts[1] = [endX ?? 0, parseFloat(v)];
          else if (type === "3DFACE" && e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          break;
        case "12":
          if (type === "3DFACE") e.verts.push([parseFloat(v), NaN]);
          break;
        case "22":
          if (type === "3DFACE" && e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          break;
        case "13":
          if (type === "3DFACE") e.verts.push([parseFloat(v), NaN]);
          break;
        case "23":
          if (type === "3DFACE" && e.verts.length) e.verts[e.verts.length - 1][1] = parseFloat(v);
          break;
        case "41":
          e.scale[0] = parseFloat(v) || 1;
          break;
        case "42":
          e.scale[1] = parseFloat(v) || 1;
          break;
        case "50":
          e.rotation = (parseFloat(v) || 0) * (Math.PI / 180);
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

function emitGeometryFeatures(
  entities: RawEntity[],
  blocks: Record<string, BlockDef>,
  xform: TransformFn,
  depth: number,
  parentLayer: string | null,
  out: Feature[]
): void {
  if (depth > MAX_BLOCK_DEPTH) return;

  for (const e of entities) {
    const layer = effectiveLayer(e.layer, parentLayer);

    if (e.type === "INSERT") {
      const blk = e.blockName ? blocks[e.blockName] : undefined;
      if (!blk) continue;
      const local = insertTransform(blk.base, e.insert, e.scale, e.rotation);
      const composed: TransformFn = (p) => xform(local(p));
      emitGeometryFeatures(blk.entities, blocks, composed, depth + 1, layer, out);
      continue;
    }

    if (e.type === "TEXT" || e.type === "MTEXT") {
      const pt = e.verts[0];
      if (!pt || pt.some((n) => !Number.isFinite(n))) continue;
      const [x, y] = xform(pt);
      out.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [x, y] },
        properties: { Layer: layer, Text: decodeMText(e.text ?? "").trim() },
      });
      continue;
    }

    if (e.type === "POINT") {
      const pt = e.verts[0];
      if (!pt || pt.some((n) => !Number.isFinite(n))) continue;
      const [x, y] = xform(pt);
      out.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [x, y] },
        properties: { Layer: layer },
      });
      continue;
    }

    if (e.type === "3DFACE") {
      // Face pleine (3 ou 4 coins) : fréquente pour les parcelles/emprises
      // dessinées en surface. Sans cela, ces parcelles n'arrivaient jamais
      // dans le GeoJSON (le driver n'émettait aucune géométrie 3DFACE).
      const verts = e.verts.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (verts.length < 3) continue;
      const world = verts.map(xform);
      // Retire les sommets consécutifs identiques (une face triangulaire répète
      // souvent le 4ᵉ coin = 3ᵉ) avant de refermer l'anneau.
      const ring: Pt[] = [];
      for (const p of world) {
        const prev = ring[ring.length - 1];
        if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) ring.push(p);
      }
      if (ring.length < 3) continue;
      ring.push(ring[0]);
      out.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { Layer: layer },
      });
      continue;
    }

    if (e.type === "LINE" || e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
      const verts = e.verts.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (verts.length < 2) continue;
      const world = verts.map(xform);
      if (e.closed && world.length >= 3) {
        const ring = [...world, world[0]];
        out.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [ring] },
          properties: { Layer: layer },
        });
      } else {
        out.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: world },
          properties: { Layer: layer },
        });
      }
      continue;
    }
  }
}

// ───────────────────────────── API ─────────────────────────────

const IDENTITY: TransformFn = (p) => p;

/**
 * Lit un DXF (Buffer) et retourne toutes les entités géométriques en
 * coordonnées monde (EPSG:32628), blocs dépliés. Lève une erreur si le DXF
 * ne contient pas de section ENTITIES exploitable.
 */
export function readDxfWorldFeatures(buffer: Buffer): GeoJSON.FeatureCollection {
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
  emitGeometryFeatures(modelEntities, blocks, IDENTITY, 0, null, out);

  return { type: "FeatureCollection", features: out };
}
