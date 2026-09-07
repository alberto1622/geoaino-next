/**
 * polygonize.ts
 *
 * Reconstruction de polygones fermés à partir d'un réseau de lignes
 * (segments de limites de parcelle dessinés séparément, fréquents dans les
 * DXF issus d'une conversion DGN/Microstation). S'appuie sur JSTS :
 *   1. noding du réseau (UnaryUnionOp casse les lignes à leurs intersections),
 *   2. polygonisation (Polygonizer assemble les anneaux fermés minimaux).
 *
 * Les coordonnées sont planes (EPSG:32628, mètres) : l'aire JSTS est donc
 * directement en m², ce qui permet de filtrer les artefacts.
 */

import * as jsts from "jsts";

type LineCoords = number[][]; // [[x,y], ...]

function ringFromJsts(coords: Array<{ x: number; y: number }>): number[][] {
  return coords.map((c) => [c.x, c.y]);
}

function jstsPolygonToCoordinates(poly: {
  getExteriorRing: () => { getCoordinates: () => Array<{ x: number; y: number }> };
  getNumInteriorRing: () => number;
  getInteriorRingN: (i: number) => { getCoordinates: () => Array<{ x: number; y: number }> };
}): number[][][] {
  const rings: number[][][] = [ringFromJsts(poly.getExteriorRing().getCoordinates())];
  const holes = poly.getNumInteriorRing();
  for (let i = 0; i < holes; i++) {
    rings.push(ringFromJsts(poly.getInteriorRingN(i).getCoordinates()));
  }
  return rings;
}

export interface PolygonizeOptions {
  /** Aire minimale (m²) d'un polygone conservé. Élimine les slivers. */
  minAreaM2?: number;
  /** Aire maximale (m²) conservée. Élimine l'anneau enveloppe global. */
  maxAreaM2?: number;
  /**
   * Au-delà de ce nombre de lignes, la polygonisation est partitionnée en
   * tuiles spatiales (cf. `polygonizeTiled`) : un `UnaryUnion` global sur des
   * centaines de milliers de segments (DXF issu d'un DGN cadastral) ne revient
   * jamais. En-dessous, on garde le chemin direct (union globale, déterministe).
   */
  tileThreshold?: number;
  /**
   * Nombre de segments visé par tuile. Borne le coût du noding/polygonisation
   * de chaque tuile.
   */
  tileTargetSegments?: number;
  /**
   * Marge (m) ajoutée autour de chaque tuile pour la collecte des segments :
   * doit dépasser le diamètre d'une parcelle pour garantir qu'une parcelle dont
   * le centroïde tombe dans la tuile a TOUS ses segments présents dans la
   * fenêtre élargie (sinon elle ne se referme pas). ~400 m > côté d'une parcelle
   * de 50 000 m² (≈224 m).
   */
  tileMarginM?: number;
  /**
   * Tolérance (m) de raccord des extrémités pendantes AVANT noding : une limite
   * mitoyenne qui s'arrête à quelques cm du contour (« undershoot » de
   * numérisation) est un *dangle* que le Polygonizer ignore → les deux parcelles
   * voisines sortent FUSIONNÉES en une seule face. Le raccord referme ces
   * micro-trous. 0 = désactivé.
   */
  snapToleranceM?: number;
  /**
   * Rempli (si fourni) par les régions abandonnées faute de noding possible
   * même après subdivision maximale — TOUTES les parcelles qu'elles
   * dessinaient sont alors perdues. Sans ce tableau, seul un `console.warn`
   * (serveur) signalait la perte : invisible depuis le navigateur (§ 28).
   */
  droppedRegions?: Array<{ x0: number; y0: number; x1: number; y1: number; segments: number }>;
  /**
   * Rempli (si fourni) par les segments de limite restés PENDANTS après
   * `healUndershoots` (extrémité à plus de `snapToleranceM` de tout autre
   * sommet/segment) : le `Polygonizer` JSTS les exclut silencieusement de
   * `getPolygons()` (`this._dangles = this._graph.deleteDangles()`), sans
   * qu'aucun autre compteur du pipeline ne les recense — contrairement à
   * `droppedRegions` (région entière abandonnée) ou aux entités de type non
   * géré (§ 50-52), ce cas correspond à une entité BIEN émise, sur un calque
   * polygonisable, juste jamais refermée en anneau. Cf. § 53,
   * docs/CONCEPTS-TRAITEMENT-DXF.md.
   */
  dangles?: Array<{
    x0: number; y0: number; x1: number; y1: number;
    /** Extrémités réelles (premier/dernier sommet), pas l'enveloppe — cf. § 53 bis. */
    p0: [number, number]; p1: [number, number];
    lengthM: number; selfGapM: number; numVertices: number; sourceEntity: string;
  }>;
  /**
   * Type DXF source (`_dgid_source_entity`) de chaque ligne de `lines`, MÊME
   * INDEX/ORDRE (cf. `parcelle-ingestion.ts` · `boundarySourceEntityByClass`).
   * Utilisé UNIQUEMENT pour retrouver le type exact d'un dangle isolé après
   * raccord (§ 53) — ne participe à aucun calcul géométrique.
   */
  lineSourceEntities?: string[];
  /**
   * Rempli (si fourni) par les paires de lignes quasi-doublons réconciliées
   * AVANT noding (§ 53 quater) : même limite dessinée deux fois avec une
   * imprécision de digitalisation (sommet quasi partagé, colinéaire, bouts
   * libres à ≤ `DUPLICATE_EDGE_MAX_GAP_M` OU copie courte posée sur la longue)
   * — une seule conservée. Purement diagnostique, ne change pas le comportement
   * de la réconciliation elle-même. `farGapM` = distance entre bouts libres
   * (peut dépasser `DUPLICATE_EDGE_MAX_GAP_M` quand c'est le critère « posée
   * sur le segment » qui a retenu la paire).
   */
  nearDuplicateEdges?: Array<{
    keptIndex: number;
    droppedIndex: number;
    farGapM: number;
    angleDeg: number;
  }>;
}

const TILE_THRESHOLD = Number(process.env.DXF_POLYGONIZE_TILE_THRESHOLD || 20000);
const TILE_TARGET_SEGMENTS = Number(process.env.DXF_POLYGONIZE_TILE_TARGET || 4000);
const TILE_MARGIN_M = Number(process.env.DXF_POLYGONIZE_TILE_MARGIN_M || 400);
// Une tuile de la grille uniforme peut, sur un fichier départemental où les
// parcelles sont concentrées (cœur urbain dense noyé dans des communes rurales
// éparses), absorber >100 000 segments : la grille est calibrée sur la densité
// MOYENNE, pas locale. Un tel bloc fait échouer le noding (« non-noded
// intersection ») même après snap-rounding → tuile perdue → tout le centre-ville
// disparaît. On subdivise donc récursivement toute tuile dépassant ce seuil (ou
// qui échoue au noding) jusqu'à des sous-tuiles nodables. `MAX_DEPTH` borne la
// récursion ; `MIN_TILE_M` empêche de subdiviser sous la taille d'une parcelle.
const TILE_MAX_SEGMENTS = Number(process.env.DXF_POLYGONIZE_TILE_MAX_SEGMENTS || 8000);
const TILE_MAX_DEPTH = Number(process.env.DXF_POLYGONIZE_TILE_MAX_DEPTH || 8);
const TILE_MIN_SIZE_M = Number(process.env.DXF_POLYGONIZE_TILE_MIN_SIZE_M || 500);
// Garde-fou pour les tuiles arrivées à la taille plancher (`TILE_MIN_SIZE_M`,
// donc impossibles à subdiviser davantage) mais encore très au-dessus de
// `TILE_MAX_SEGMENTS` : une vraie densité cadastrale ne dépasse jamais ce
// seuil sur une aire aussi petite (des dizaines de milliers de segments sur
// quelques milliers de m² impliqueraient des parcelles d'une fraction de m²)
// — c'est le signe d'un artefact de tracé (quasi-doublons non exacts, hatch
// mal classé sur le calque limites) plutôt que de vraies parcelles. Observé
// en pratique : des tuiles à 30-70k segments prenaient 150 à 2400 s CHACUNE
// (JSTS `UnaryUnionOp` sur géométrie quasi-dégénérée) sans jamais échouer —
// donc jamais comptabilisées comme perdues, juste interminables. Abandonner
// SANS tenter le noding au-delà de ce seuil transforme un blocage de plusieurs
// heures en une zone perdue mais comptée (même mécanique que `droppedRegions`).
const TILE_HARD_DROP_SEGMENTS = Number(process.env.DXF_POLYGONIZE_TILE_HARD_DROP_SEGMENTS || 20000);
// Tolérance de raccord des extrémités pendantes (cf. `healUndershoots`). Deux
// sommets cadastraux distincts sont à plusieurs mètres l'un de l'autre (le
// plus petit écartement observé sur les limites de refend, § 53, est de
// l'ordre de 10 m) : 1 m referme les trous de numérisation sans risquer de
// fusionner deux sommets légitimes. Valeur alignée sur `SECTION_SNAP_TOLERANCE_M`
// (parcelle-ingestion.ts), déjà utilisée en production pour le réseau sections
// sans problème observé. Relevée de 25 cm à 1 m (§ 53, patron « presque
// fermable ») après mesure sur ZIG.dxf : sur les dangles à distance mini
// 0,25-1 m d'un autre dangle (≈14 % des 33 134 dangles distincts du réseau
// parcelles), la quasi-totalité correspond à un vrai écart de numérisation,
// pas à deux sommets distincts rapprochés par coïncidence. Le lot 1-2 m
// (≈9 % de plus) reste hors de cette tolérance — laissé de côté par prudence,
// non mesuré aussi finement.
const SNAP_TOLERANCE_M = Number(process.env.DXF_POLYGONIZE_SNAP_TOLERANCE_M ?? 1);

// ── Réconciliation des arêtes quasi-doublons (§ 53 quater) ─────────────────────
// Cas réel Matam_Ourossogui.dxf (signalé par l'utilisateur) : une limite
// interne dessinée DEUX FOIS avec une imprécision de digitalisation — même
// sommet de départ, bout libre différent de quelques mètres — n'a NI l'une
// NI l'autre extrémité libre à portée de `healUndershoots` (§ 53 : 3-25 m,
// hors de portée d'une tolérance de raccord raisonnable). Le Polygonizer JSTS
// exclut les DEUX comme dangles ; le contour extérieur se referme quand même,
// fusionnant plusieurs parcelles en une (confirmé : 2 étiquettes distinctes
// retrouvées dans un même polygone de 2000 m² contre ~500 m² pour ses
// voisines). Traiter ceci comme un dédoublonnage AVANT noding — pas comme un
// relâchement de `SNAP_TOLERANCE_M`, qui ne referme rien ici (testé jusqu'à
// 5-6 m sans effet) et risquerait de souder deux sommets cadastraux distincts
// ailleurs dans le fichier (le plus petit écartement observé entre deux
// sommets distincts est de l'ordre de 10 m, cf. commentaire SNAP_TOLERANCE_M).
//
// Sommet "presque exact" : bruit d'arrondi à l'export, pas une coïncidence de
// voisinage — nettement plus strict que SNAP_TOLERANCE_M.
const DUPLICATE_EDGE_VERTEX_EPS_M = 0.02;
// Angle max (°) entre les deux segments depuis leur sommet (quasi-)partagé.
// Deux limites RÉELLEMENT distinctes qui partent du même coin divergent
// nettement (mesuré sur le cas réel : les vraies paires quasi-doublons sont
// à 0,0°, marge généreuse ici pour absorber le bruit de digitalisation).
const DUPLICATE_EDGE_MAX_ANGLE_DEG = 12;
// Écart max (m) au bout LIBRE (non partagé) pour rester la MÊME limite
// esquissée deux fois. Au-delà, deux tracés colinéaires partant du même point
// sont plus probablement deux limites distinctes en enfilade (mitoyennes
// successives) qu'un doublon. Distinct de SNAP_TOLERANCE_M : ceci n'est PAS
// un raccord d'extrémité pendante, c'est une réconciliation de doublon AVANT
// même le raccord — testé et validé (43→46 polygones, 0 nouvel outlier) sur
// les vraies coordonnées du cas Matam_Ourossogui avant d'être intégré ici.
const DUPLICATE_EDGE_MAX_GAP_M = Number(process.env.DXF_DUPLICATE_EDGE_MAX_GAP_M ?? 5);
// § 53 quater : deuxième critère d'acceptation d'une paire quasi-doublon, pour
// le cas où le bout libre est BEAUCOUP plus loin que `DUPLICATE_EDGE_MAX_GAP_M`
// simplement parce qu'une des deux copies est plus COURTE que l'autre (re-tracé
// partiel). On accepte alors la paire quand le bout libre de la copie courte
// est POSÉ sur le segment de la copie longue (projection clampée ≤ ce seuil) :
// la courte est géométriquement incluse dans la longue, la retirer ne peut
// enlever aucune information. Cas réel Matam_Ourossogui (bloc parcelle 4242,
// h. 95B186 50 m vs 95B21D 37,7 m, colinéaires, sommet bas partagé, bouts
// hauts à 12,3 m l'un de l'autre) : le seul critère « bouts libres ≤ 5 m »
// laissait passer les deux copies → 2 parcelles restaient fusionnées en une
// (1000 m² au lieu de 2×500). Validé plein fichier : +68 polygones,
// −302 dangles, outliers ≥3× 299→280 (et ≥5/10/20× tous en baisse),
// aire totale +0,06 %, ~3,9 % des lignes retirées, aucune régression.
const DUPLICATE_EDGE_ON_SEGMENT_EPS_M = Number(process.env.DXF_DUPLICATE_EDGE_ON_SEGMENT_EPS_M ?? 0.5);

type LineBBox = [number, number, number, number]; // [minX, minY, maxX, maxY]

function lineBBox(line: LineCoords): LineBBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of line) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Node puis polygonise un sous-ensemble de lignes en une seule passe (union
 * globale). Conserve les polygones dont l'aire ∈ [minArea, maxArea] et,
 * optionnellement, dont le centroïde satisfait `ownsPolygon` (attribution à
 * une tuile unique pour éviter les doublons en bordure de tuile).
 */
// Échelles de snap-rounding (unités = 1/scale mètre) essayées successivement
// pour le noding. Les réseaux cadastraux issus d'un DGN portent des
// micro-intersections (deux limites se croisant à ~0,01 mm près, présentes dans
// une ligne mais pas l'autre) qui font échouer le noding « rapide » d'UnaryUnion
// (« found non-noded intersection »). En accrochant explicitement les
// coordonnées à une grille de plus en plus grossière (1 mm → 1 cm → 5 cm →
// 10 cm → 20 cm) via GeometryPrecisionReducer, le réseau devient noded de façon
// cohérente. Les deux dernières échelles (10/5) ne sont atteintes qu'en dernier
// recours (les erreurs topologiques franches, sommet manquant sur la ligne
// croisée, résistent au snap fin) : un snap à 20 cm peut fusionner deux sommets
// distincts proches, acceptable seulement quand tout le reste a échoué. Un simple
// PrecisionModel sur la GeometryFactory ne suffit PAS : `createLineString`
// n'arrondit pas les coordonnées, seul le réducteur le fait.
const PRECISION_SCALES = (process.env.DXF_POLYGONIZE_PRECISION_SCALES || "1000,100,20,10,5")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * Union/noding robuste d'un MultiLineString : tente le noding après snap-rounding
 * à des grilles de plus en plus grossières jusqu'à réussite. Relève la dernière
 * erreur si toutes les échelles échouent (traité en amont par tuile).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function robustNodedUnion(mls: any): any {
  let lastErr: unknown;
  for (const scale of PRECISION_SCALES) {
    try {
      const reducer = new jsts.precision.GeometryPrecisionReducer(
        new jsts.geom.PrecisionModel(scale)
      );
      const reduced = reducer.reduce(mls);
      return jsts.operation.union.UnaryUnionOp.union(reduced);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Compteurs de raccord (diagnostic ; en tuilé, une extrémité en marge peut être comptée dans plusieurs tuiles). */
interface HealStats {
  /** Extrémités regroupées sur une extrémité voisine (trou coin-à-coin). */
  endpointsClustered: number;
  /** Extrémités raccrochées à un segment/sommet voisin (undershoot en T). */
  endpointsSnapped: number;
  /**
   * Régions abandonnées faute de noding possible, même après subdivision
   * maximale (cf. `polygonizeTiled`) — TOUS les segments de la région sont
   * alors perdus, avec toutes les parcelles qu'ils dessinaient. Auparavant
   * seulement `console.warn` (invisible du navigateur) : exposé ici pour
   * remonter jusqu'aux avertissements d'ingestion (§ 28).
   */
  droppedRegions: Array<{ x0: number; y0: number; x1: number; y1: number; segments: number }>;
  /** Cf. `PolygonizeOptions.dangles`. */
  dangles: Array<{
    x0: number; y0: number; x1: number; y1: number;
    p0: [number, number]; p1: [number, number];
    lengthM: number; selfGapM: number; numVertices: number; sourceEntity: string;
  }>;
}

/**
 * Referme les micro-trous du réseau de limites AVANT noding. Deux défauts de
 * numérisation distincts font fusionner des parcelles voisines :
 *
 *  - « undershoot » : la limite mitoyenne s'arrête à quelques cm du contour →
 *    ligne pendante (*dangle*), ignorée par le Polygonizer → une seule face
 *    couvrant les deux parcelles ;
 *  - trou coin-à-coin : deux limites censées se rejoindre en un coin s'arrêtent
 *    à quelques cm l'une de l'autre → l'anneau ne se referme pas du tout.
 *
 * Deux passes :
 *  1. regroupement des extrémités à ≤ tol l'une de l'autre sur une position
 *     canonique (la première vue — les représentants ne bougent jamais, donc
 *     pas d'effet de cascade) ;
 *  2. pour chaque extrémité encore pendante, raccord au segment le plus proche
 *     (≤ tol) : l'extrémité est déplacée sur sa projection ET ce point est
 *     INSÉRÉ comme sommet du segment cible — le partage de coordonnée exact
 *     garantit le noding, là où un point « presque sur » la ligne (~1e-13 m)
 *     peut échapper au test d'intersection robuste.
 *
 * Ne mute jamais les tableaux d'entrée (partagés entre tuiles via les fenêtres
 * à marge) : copie à l'écriture.
 */
function healUndershoots(lines: LineCoords[], tol: number, stats?: HealStats): LineCoords[] {
  if (!(tol > 0) || lines.length === 0) return lines;
  const tolSq = tol * tol;
  // Seule une coordonnée EXACTEMENT partagée avec un sommet garantit le noding.
  // Un seuil de « contact » par distance (même 1 µm) est un faux ami : un point
  // à 0,7 µm d'un segment n'est PAS une intersection pour le noding robuste
  // (cas réel : mitoyenne des sections 017/020 de DYA, restée pendante). On ne
  // court-circuite donc que sur l'égalité exacte de sommet ; toute distance > 0
  // à un segment est raccordée par insertion (coordonnée partagée garantie).
  const vertexExactSq = 1e-20;

  const out: LineCoords[] = lines.slice();
  const owned = new Array<boolean>(lines.length).fill(false);
  const own = (i: number): LineCoords => {
    if (!owned[i]) {
      out[i] = out[i].map((c) => [c[0], c[1]]);
      owned[i] = true;
    }
    return out[i];
  };

  // Extrémités libres : premières/dernières coordonnées des polylignes ouvertes.
  const endpoints: Array<[number, number]> = []; // [indice ligne, indice sommet]
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    if (l.length < 2) continue;
    const f = l[0];
    const e = l[l.length - 1];
    if (f[0] === e[0] && f[1] === e[1]) continue; // anneau fermé : rien à raccorder
    endpoints.push([i, 0], [i, l.length - 1]);
  }
  if (endpoints.length === 0) return out;

  const keyOf = (cx: number, cy: number) => cx + ":" + cy;

  // ---- Passe 1 : regroupement des extrémités proches (trous coin-à-coin). ----
  const repGrid = new Map<string, Array<[number, number]>>();
  for (const [li, vi] of endpoints) {
    const p = out[li][vi];
    const cx = Math.floor(p[0] / tol);
    const cy = Math.floor(p[1] / tol);
    let rep: [number, number] | null = null;
    for (let dx = -1; dx <= 1 && !rep; dx++) {
      for (let dy = -1; dy <= 1 && !rep; dy++) {
        const reps = repGrid.get(keyOf(cx + dx, cy + dy));
        if (!reps) continue;
        for (const r of reps) {
          const ddx = r[0] - p[0];
          const ddy = r[1] - p[1];
          if (ddx * ddx + ddy * ddy <= tolSq) {
            rep = r;
            break;
          }
        }
      }
    }
    if (rep) {
      if (rep[0] !== p[0] || rep[1] !== p[1]) {
        own(li)[vi] = [rep[0], rep[1]];
        if (stats) stats.endpointsClustered++;
      }
    } else {
      const k = keyOf(cx, cy);
      const arr = repGrid.get(k);
      const self: [number, number] = [p[0], p[1]];
      if (arr) arr.push(self);
      else repGrid.set(k, [self]);
    }
  }

  // ---- Passe 2 : extrémités pendantes → raccord au segment le plus proche. ----
  // Index spatial des segments (bbox → cellules de grille). La taille de
  // cellule est bornée par l'étendue du PLUS GRAND segment : chaque segment
  // est inséré dans toutes les cellules du rectangle de sa bbox, donc un
  // segment kilométrique sur des cellules de 8 m insérerait des MILLIONS de
  // cellules (« RangeError: Map maximum size exceeded » — limites de sections
  // Matam). Avec la borne, ≤ ~65 cellules par axe et par segment ; des
  // cellules plus grandes ajoutent des candidats par requête, mais le calcul
  // de distance exact filtre — seul le coût varie, jamais le résultat.
  let maxSpan = 0;
  for (const l of out) {
    for (let s = 0; s < l.length - 1; s++) {
      const w = Math.abs(l[s + 1][0] - l[s][0]);
      const h = Math.abs(l[s + 1][1] - l[s][1]);
      if (w > maxSpan) maxSpan = w;
      if (h > maxSpan) maxSpan = h;
    }
  }
  const segCell = Math.max(tol * 4, 8, maxSpan / 64);
  const segs: Array<[number, number]> = []; // [indice ligne, indice du 1er sommet]
  const segGrid = new Map<string, number[]>();
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    for (let s = 0; s < l.length - 1; s++) {
      const idx = segs.length;
      segs.push([i, s]);
      const x0 = Math.min(l[s][0], l[s + 1][0]);
      const x1 = Math.max(l[s][0], l[s + 1][0]);
      const y0 = Math.min(l[s][1], l[s + 1][1]);
      const y1 = Math.max(l[s][1], l[s + 1][1]);
      for (let cx = Math.floor(x0 / segCell); cx <= Math.floor(x1 / segCell); cx++) {
        for (let cy = Math.floor(y0 / segCell); cy <= Math.floor(y1 / segCell); cy++) {
          const k = keyOf(cx, cy);
          const arr = segGrid.get(k);
          if (arr) arr.push(idx);
          else segGrid.set(k, [idx]);
        }
      }
    }
  }

  // Points à insérer dans les segments cibles, appliqués en bloc à la fin (les
  // indices de sommets restent stables pendant la boucle de décision).
  const insertions = new Map<number, Array<{ s: number; t: number; x: number; y: number }>>();

  for (const [li, vi] of endpoints) {
    const p = out[li][vi];
    const px = p[0];
    const py = p[1];
    // Segment incident à cette extrémité (contient p à distance 0 : à ignorer).
    const incident = vi === 0 ? 0 : out[li].length - 2;

    let touching = false;
    let bestSegIdx = -1;
    let bestSegD2 = tolSq;
    let bestT = 0;
    let bestX = 0;
    let bestY = 0;
    // Infinity (et non tolSq) : sinon, sans aucun candidat, vertD == tol
    // validerait `vertD <= tol` et raccorderait vers les coordonnées par défaut.
    let bestVertD2 = Infinity;
    let bestVX = 0;
    let bestVY = 0;

    const cx0 = Math.floor((px - tol) / segCell);
    const cx1 = Math.floor((px + tol) / segCell);
    const cy0 = Math.floor((py - tol) / segCell);
    const cy1 = Math.floor((py + tol) / segCell);
    const seen = new Set<number>();
    for (let cx = cx0; cx <= cx1 && !touching; cx++) {
      for (let cy = cy0; cy <= cy1 && !touching; cy++) {
        const arr = segGrid.get(keyOf(cx, cy));
        if (!arr) continue;
        for (const idx of arr) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const [sl, ss] = segs[idx];
          if (sl === li && ss === incident) continue;
          const line = out[sl];
          const ax = line[ss][0];
          const ay = line[ss][1];
          const bx = line[ss + 1][0];
          const by = line[ss + 1][1];
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = ax + t * dx;
          const qy = ay + t * dy;
          const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
          const dva = (px - ax) * (px - ax) + (py - ay) * (py - ay);
          const dvb = (px - bx) * (px - bx) + (py - by) * (py - by);
          // Sommet exactement partagé (jonction en coin déjà nodale) : rien à faire.
          if (dva <= vertexExactSq || dvb <= vertexExactSq) {
            touching = true;
            break;
          }
          if (dva < bestVertD2) {
            bestVertD2 = dva;
            bestVX = ax;
            bestVY = ay;
          }
          if (dvb < bestVertD2) {
            bestVertD2 = dvb;
            bestVX = bx;
            bestVY = by;
          }
          if (d2 < bestSegD2) {
            bestSegD2 = d2;
            bestSegIdx = idx;
            bestT = t;
            bestX = qx;
            bestY = qy;
          }
        }
      }
    }
    if (touching) continue;

    const segD = bestSegIdx >= 0 ? Math.sqrt(bestSegD2) : Infinity;
    const vertD = Math.sqrt(bestVertD2);
    // Sommet existant presque aussi proche que la projection : raccord « propre »
    // (coordonnée déjà partagée, pas d'insertion). La distorsion reste ≤ tol.
    if (vertD <= tol && vertD <= segD + tol * 0.5) {
      own(li)[vi] = [bestVX, bestVY];
      if (stats) stats.endpointsSnapped++;
    } else if (bestSegIdx >= 0) {
      own(li)[vi] = [bestX, bestY];
      const [sl, ss] = segs[bestSegIdx];
      let arr = insertions.get(sl);
      if (!arr) {
        arr = [];
        insertions.set(sl, arr);
      }
      arr.push({ s: ss, t: bestT, x: bestX, y: bestY });
      if (stats) stats.endpointsSnapped++;
    }
  }

  // Application des insertions : reconstruit chaque ligne cible avec les points
  // projetés intercalés dans l'ordre (indice de segment, abscisse curviligne).
  for (const [li, ins] of insertions) {
    const line = own(li);
    ins.sort((a, b) => a.s - b.s || a.t - b.t);
    const rebuilt: number[][] = [];
    let k = 0;
    for (let v = 0; v < line.length; v++) {
      rebuilt.push(line[v]);
      while (k < ins.length && ins[k].s === v) {
        const prev = rebuilt[rebuilt.length - 1];
        if (prev[0] !== ins[k].x || prev[1] !== ins[k].y) {
          rebuilt.push([ins[k].x, ins[k].y]);
        }
        k++;
      }
    }
    out[li] = rebuilt;
  }

  return out;
}

/**
 * Clé canonique (orientation neutralisée, comme `canonicalLineKey`) mais
 * arrondie au mm — tolère les micro-perturbations flottantes introduites par
 * `GeometryPrecisionReducer`/`UnaryUnionOp` (§ 53). Sert UNIQUEMENT à retrouver
 * le type source d'un dangle après noding, jamais à la déduplication
 * géométrique (`canonicalLineKey`, qui doit rester une égalité stricte).
 * Un dangle dont la clé ne trouve aucune correspondance (ex. tuile retombée
 * sur une échelle de précision plus grossière que 1 mm, cf. `PRECISION_SCALES`)
 * reste marqué "?" plutôt que de deviner — jamais de faux positif.
 */
function roundedLineKey(coords: Array<{ x: number; y: number }> | number[][]): string {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const pts = (coords as Array<{ x: number; y: number } | number[]>).map((c) => {
    const [x, y] = Array.isArray(c) ? c : [c.x, c.y];
    return `${round(x)},${round(y)}`;
  });
  const rev = pts.slice().reverse().join(";");
  const fwd = pts.join(";");
  return fwd < rev ? fwd : rev;
}

function polygonizeChunk(
  lines: LineCoords[],
  minArea: number,
  maxArea: number,
  ownsPolygon?: (cx: number, cy: number) => boolean,
  snapTol = 0,
  stats?: HealStats,
  sourceEntities?: string[]
): GeoJSON.Polygon[] {
  // Raccord des micro-trous (undershoots/coins ouverts) avant noding : sans lui,
  // les limites mitoyennes pendantes font fusionner les parcelles voisines.
  const healed = healUndershoots(lines, snapTol, stats);

  // Type source EXACT (§ 53) d'un dangle isolé : table de correspondance
  // clé-arrondie(ligne après raccord) → `_dgid_source_entity`, construite AVANT
  // le passage par `GeometryPrecisionReducer` (qui peut légèrement déplacer les
  // coordonnées, cf. `roundedLineKey`) — `healed` est le dernier état des
  // coordonnées encore indexé en lockstep avec `sourceEntities`.
  let sourceByKey: Map<string, string> | null = null;
  if (stats && sourceEntities) {
    sourceByKey = new Map();
    healed.forEach((l, i) => sourceByKey!.set(roundedLineKey(l), sourceEntities[i] ?? "?"));
  }

  const gf = new jsts.geom.GeometryFactory();
  const jstsLines = healed
    .filter((l) => Array.isArray(l) && l.length >= 2)
    .map((l) =>
      gf.createLineString(l.map(([x, y]: number[]) => new jsts.geom.Coordinate(x, y)))
    );

  if (jstsLines.length === 0) return [];

  const mls = gf.createMultiLineString(jstsLines);
  // Noding robuste (snap-rounding progressif), pré-requis du Polygonizer.
  const noded = robustNodedUnion(mls);

  const polygonizer = new jsts.operation.polygonize.Polygonizer();
  polygonizer.add(noded);

  const result: GeoJSON.Polygon[] = [];
  const polys = polygonizer.getPolygons().toArray();
  for (const poly of polys) {
    const area = poly.getArea();
    if (area < minArea || area > maxArea) continue;
    if (ownsPolygon) {
      const c = poly.getCentroid().getCoordinate();
      if (!ownsPolygon(c.x, c.y)) continue;
    }
    result.push({ type: "Polygon", coordinates: jstsPolygonToCoordinates(poly) });
  }

  // Segments restés pendants après `healUndershoots` (§ 53) : jamais dans
  // `getPolygons()`, donc invisibles sans cet appel dédié. Diagnostic
  // uniquement — ne change aucun comportement, juste le recensement.
  if (stats) {
    for (const dangle of polygonizer.getDangles().toArray()) {
      const env = dangle.getEnvelopeInternal();
      // Écart d'auto-fermeture : distance entre le PREMIER et le DERNIER
      // sommet de ce dangle. Pour une entité isolée (aucune intersection
      // avec une autre limite, donc jamais fragmentée par le noding — cas
      // image-8.png), le dangle EST l'entité d'origine en entier : cette
      // distance est alors l'écart réel entre son premier et son dernier
      // sommet dessinés, indépendamment de tout autre segment du fichier.
      // Un petit écart signale un candidat sûr pour une fermeture dédiée
      // (ne touche PAS `snapToleranceM`, donc aucun risque de fusionner deux
      // sommets cadastraux distincts ailleurs — cf. pièges § 53).
      const coords = dangle.getCoordinates();
      const first = coords[0];
      const last = coords[coords.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      stats.dangles.push({
        x0: env.getMinX(),
        y0: env.getMinY(),
        x1: env.getMaxX(),
        y1: env.getMaxY(),
        // Extrémités RÉELLES (pas l'enveloppe, qui ne coïncide avec aucun
        // sommet dès que le dangle a plus de 2 points) — cf. § 53 bis,
        // détection des anneaux "authored" à réinjecter par dangle réel
        // plutôt que par simple proximité de n'importe quelle ligne.
        p0: [first.x, first.y],
        p1: [last.x, last.y],
        lengthM: dangle.getLength(),
        selfGapM: Math.sqrt(dx * dx + dy * dy),
        // Conservé à titre de recoupement (proxy géométrique) désormais
        // doublé du VRAI type source ci-dessous — cf. § 53.
        numVertices: coords.length,
        // Type DXF source EXACT (`_dgid_source_entity`), retrouvé via la clé
        // arrondie de ce dangle. "?" = pas de correspondance exacte (dangle
        // né d'une fusion/fragmentation par le noding avec une autre ligne,
        // ou tuile retombée sur une échelle de précision plus grossière que
        // 1 mm) — jamais deviné, cf. `roundedLineKey`.
        sourceEntity: sourceByKey?.get(roundedLineKey(coords)) ?? "?",
      });
    }
  }
  return result;
}

/**
 * Polygonisation partitionnée en tuiles spatiales pour les très gros réseaux de
 * segments. Chaque tuile collecte les segments dont la bbox intersecte la tuile
 * élargie d'une marge `tileMarginM` (donc tous les segments de toute parcelle
 * dont le centroïde tombe dans la tuile « cœur »), polygonise localement, puis
 * ne conserve que les polygones dont le centroïde appartient à la tuile cœur.
 * Chaque parcelle est ainsi reconstruite et comptée exactement une fois.
 */
function polygonizeTiled(
  lines: LineCoords[],
  minArea: number,
  maxArea: number,
  targetSegments: number,
  marginM: number,
  snapTol: number,
  stats?: HealStats,
  sourceEntities?: string[]
): GeoJSON.Polygon[] {
  const bboxes = lines.map(lineBBox);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [bx0, by0, bx1, by1] of bboxes) {
    if (bx0 < minX) minX = bx0;
    if (by0 < minY) minY = by0;
    if (bx1 > maxX) maxX = bx1;
    if (by1 > maxY) maxY = by1;
  }
  if (!Number.isFinite(minX)) return [];

  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);

  // Nombre de tuiles ≈ nLines / targetSegments, réparti en grille carrée : c'est
  // la découpe INITIALE (densité moyenne). Les tuiles localement trop denses sont
  // ensuite subdivisées récursivement (cf. `processRegion`).
  const nTiles = Math.max(1, Math.ceil(lines.length / Math.max(1, targetSegments)));
  const tilesPerAxis = Math.max(1, Math.ceil(Math.sqrt(nTiles)));
  const tileW = width / tilesPerAxis;
  const tileH = height / tilesPerAxis;
  console.info(
    `[polygonize] tuilage : ${lines.length} segments, grille ${tilesPerAxis}×${tilesPerAxis} ` +
      `(${tileW.toFixed(0)}×${tileH.toFixed(0)} m/tuile), marge ${marginM} m.`
  );

  const result: GeoJSON.Polygon[] = [];
  let droppedTiles = 0;
  let droppedSegments = 0;
  // Compteurs de progression — sans eux, une tuile dense en cours de noding
  // (JSTS peut prendre plusieurs minutes sur un bloc >10⁴ segments, cf.
  // TILE_MAX_SEGMENTS) est indiscernable d'un blocage : aucun log n'apparaît
  // entre le dédoublonnage et le résultat final sur un gros fichier.
  let processedCells = 0;
  const totalCells = tilesPerAxis * tilesPerAxis;

  /**
   * Polygonise une région rectangulaire [rx0,ry0]–[rx1,ry1]. `idxs` = indices des
   * segments dont la bbox élargie (marge) recouvre déjà la région. Un polygone
   * n'est conservé que si son centroïde tombe dans le CŒUR de la région (bornes
   * demi-ouvertes) → chaque parcelle est comptée exactement une fois, quelle que
   * soit la profondeur de subdivision. Si la région est trop dense (> maxSeg) ou
   * si son noding échoue, elle est découpée en 2×2 et traitée récursivement, tant
   * que la profondeur et la taille minimale le permettent. C'est la clé de la
   * récupération des cœurs urbains denses noyés dans un fichier départemental.
   */
  const processRegion = (
    idxs: number[],
    rx0: number,
    ry0: number,
    rx1: number,
    ry1: number,
    depth: number
  ): void => {
    if (idxs.length === 0) return;

    const canSplit =
      depth < TILE_MAX_DEPTH &&
      rx1 - rx0 > TILE_MIN_SIZE_M &&
      ry1 - ry0 > TILE_MIN_SIZE_M;

    // Découpe préventive des régions manifestement trop denses avant même de
    // tenter le noding (coûteux et voué à l'échec au-delà de ~10⁴ segments).
    if (idxs.length > TILE_MAX_SEGMENTS && canSplit) {
      subdivide(idxs, rx0, ry0, rx1, ry1, depth);
      return;
    }

    // Taille plancher atteinte (`!canSplit`) mais encore largement au-dessus de
    // `TILE_MAX_SEGMENTS` : pas une vraie densité cadastrale (cf. commentaire
    // `TILE_HARD_DROP_SEGMENTS`) — abandon SANS tenter le noding, plutôt que de
    // risquer plusieurs dizaines de minutes pour un résultat déjà suspect.
    if (idxs.length > TILE_HARD_DROP_SEGMENTS && !canSplit) {
      droppedTiles++;
      droppedSegments += idxs.length;
      stats?.droppedRegions.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, segments: idxs.length });
      console.warn(
        `[polygonize] région ${rx0.toFixed(0)},${ry0.toFixed(0)}–${rx1.toFixed(0)},${ry1.toFixed(0)} ` +
          `abandonnée SANS tentative de noding (${idxs.length} segments ≥ ${TILE_HARD_DROP_SEGMENTS}, ` +
          `taille plancher atteinte) — densité anormale pour une aire aussi petite, probable artefact de tracé.`
      );
      return;
    }

    const coords = idxs.map((i) => lines[i]);
    const coordsSourceEntities = sourceEntities ? idxs.map((i) => sourceEntities[i]) : undefined;
    const owns = (cx: number, cy: number) =>
      cx >= rx0 && cx < rx1 && cy >= ry0 && cy < ry1;
    // Seuil purement diagnostique (pas de comportement changé) : un bloc de
    // cette taille peut prendre plusieurs dizaines de secondes en JSTS pur JS,
    // et `robustNodedUnion` peut retenter jusqu'à 5 fois (PRECISION_SCALES)
    // avant d'échouer — sans ce log, cette attente est indiscernable d'un blocage.
    const isSlow = coords.length > 1500;
    const startedAt = isSlow ? Date.now() : 0;
    if (isSlow) {
      console.info(
        `[polygonize] noding tuile dense : ${coords.length} segments, profondeur ${depth}, ` +
          `région ${rx0.toFixed(0)},${ry0.toFixed(0)}–${rx1.toFixed(0)},${ry1.toFixed(0)} — en cours…`
      );
    }
    try {
      for (const poly of polygonizeChunk(coords, minArea, maxArea, owns, snapTol, stats, coordsSourceEntities)) {
        result.push(poly);
      }
      if (isSlow) {
        console.info(`[polygonize]   ↳ terminé en ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
      }
    } catch (err) {
      // Noding impossible même après snap-rounding : on subdivise plutôt que de
      // perdre toute la région (comportement d'origine). En dernier recours
      // (région minimale atteinte), on l'abandonne en la comptabilisant.
      if (isSlow) {
        console.info(`[polygonize]   ↳ échec après ${((Date.now() - startedAt) / 1000).toFixed(1)} s (${canSplit ? "subdivision" : "abandon"}).`);
      }
      if (canSplit) {
        subdivide(idxs, rx0, ry0, rx1, ry1, depth);
      } else {
        droppedTiles++;
        droppedSegments += coords.length;
        stats?.droppedRegions.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, segments: coords.length });
        console.warn(
          `[polygonize] région ${rx0.toFixed(0)},${ry0.toFixed(0)}–${rx1.toFixed(0)},${ry1.toFixed(0)} ignorée (${coords.length} segments, profondeur ${depth}) : ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    }
  };

  /** Découpe une région en 2×2 et répartit ses segments (bbox + marge) par quadrant. */
  const subdivide = (
    idxs: number[],
    rx0: number,
    ry0: number,
    rx1: number,
    ry1: number,
    depth: number
  ): void => {
    const mx = (rx0 + rx1) / 2;
    const my = (ry0 + ry1) / 2;
    const quads: Array<[number, number, number, number]> = [
      [rx0, ry0, mx, my],
      [mx, ry0, rx1, my],
      [rx0, my, mx, ry1],
      [mx, my, rx1, ry1],
    ];
    for (const [qx0, qy0, qx1, qy1] of quads) {
      const sub: number[] = [];
      for (const i of idxs) {
        const [bx0, by0, bx1, by1] = bboxes[i];
        // Segment retenu si sa bbox élargie de la marge recouvre le quadrant.
        if (bx1 + marginM >= qx0 && bx0 - marginM <= qx1 && by1 + marginM >= qy0 && by0 - marginM <= qy1) {
          sub.push(i);
        }
      }
      processRegion(sub, qx0, qy0, qx1, qy1, depth + 1);
    }
  };

  // Amorce sur la grille uniforme initiale (cœur = cellule, sans marge : le cœur
  // partitionne le plan, la marge n'intervient que pour COLLECTER les segments).
  for (let c = 0; c < tilesPerAxis; c++) {
    for (let r = 0; r < tilesPerAxis; r++) {
      const cx0 = minX + c * tileW;
      const cy0 = minY + r * tileH;
      const cx1 = c === tilesPerAxis - 1 ? maxX + 1e-6 : cx0 + tileW;
      const cy1 = r === tilesPerAxis - 1 ? maxY + 1e-6 : cy0 + tileH;
      const idxs: number[] = [];
      bboxes.forEach(([bx0, by0, bx1, by1], idx) => {
        if (bx1 + marginM >= cx0 && bx0 - marginM <= cx1 && by1 + marginM >= cy0 && by0 - marginM <= cy1) {
          idxs.push(idx);
        }
      });
      processRegion(idxs, cx0, cy0, cx1, cy1, 0);
      processedCells++;
      if (processedCells % 10 === 0 || processedCells === totalCells) {
        console.info(
          `[polygonize] progression : ${processedCells}/${totalCells} tuiles initiales, ${result.length} polygone(s) reconstitué(s) jusqu'ici.`
        );
      }
    }
  }

  if (droppedTiles > 0) {
    console.warn(
      `[polygonize] ${droppedTiles} région(s) irrécupérable(s) (${droppedSegments} segments) après subdivision maximale.`
    );
  }
  return result;
}

/**
 * Node puis polygonise un ensemble de lignes (coordonnées EPSG:32628).
 * Retourne des polygones GeoJSON (anneaux [extérieur, trous...]).
 *
 * Au-delà de `tileThreshold` segments, bascule sur une polygonisation par
 * tuiles spatiales (le `UnaryUnion` global ne tient pas à cette échelle).
 */
/**
 * Clé canonique d'une ligne (orientation neutralisée) pour dédoublonner les
 * tracés dupliqués (copies Microstation : chaque limite dessinée deux fois).
 * Un doublon exact n'apporte rien au noding mais MASQUE le raccord des
 * extrémités pendantes : `healUndershoots` trouve le jumeau à distance 0 et
 * croit l'extrémité « déjà connectée » — le trou en T de quelques cm n'est
 * jamais refermé et les faces voisines fusionnent (cas sections 017/020 DYA).
 */
function canonicalLineKey(line: LineCoords): string {
  const fwd = line.map((c) => c[0] + "," + c[1]).join(";");
  const rev = line.map((c) => c[0] + "," + c[1]).reverse().join(";");
  return fwd < rev ? fwd : rev;
}

/**
 * Distance d'un point au SEGMENT [a, b] (projection clampée aux extrémités —
 * pas à la droite support). Utilisé par `reconcileNearDuplicateEdges` (§ 53
 * quater) pour détecter qu'un bout libre est « posé sur » un autre segment.
 */
function pointToSegmentDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/**
 * Réconcilie les paires de lignes quasi-doublons AVANT noding (§ 53 quater) :
 * même limite dessinée deux fois avec une imprécision de digitalisation —
 * sommet de départ (quasi-)partagé (`DUPLICATE_EDGE_VERTEX_EPS_M`), colinéaire
 * depuis ce sommet (`DUPLICATE_EDGE_MAX_ANGLE_DEG`). Contrairement à
 * `canonicalLineKey` (doublon EXACT, chaîne identique), ceci couvre les
 * quasi-doublons dont l'extrémité libre diffère de quelques mètres — sans
 * réconciliation, aucune des deux extrémités libres n'a de partenaire net,
 * `healUndershoots` (§ 53) ne les raccorde pas (hors de portée d'une
 * tolérance raisonnable), et le Polygonizer JSTS exclut les DEUX comme
 * dangles : la subdivision qu'elles dessinaient disparaît silencieusement.
 *
 * Une paire est retenue si l'un des deux critères de recouvrement tient :
 *   1. les bouts LIBRES sont à ≤ `DUPLICATE_EDGE_MAX_GAP_M` l'un de l'autre —
 *      les deux copies ont ~la même longueur ;
 *   2. le bout libre de la copie COURTE est posé sur le segment de la copie
 *      LONGUE (projection clampée ≤ `DUPLICATE_EDGE_ON_SEGMENT_EPS_M`) —
 *      re-tracé partiel : une copie s'arrête plus tôt, sur la même droite.
 *
 * Ne garde qu'UNE ligne par paire. Critère 2 : on retire toujours la COURTE
 * (géométriquement incluse dans la longue). Critère 1 : celle dont le bout
 * libre est déjà ancré ailleurs dans le réseau (partagé avec une AUTRE ligne)
 * l'emporte sur une extrémité isolée — un ancrage est un indice direct de
 * tracé correctement raccordé ; à égalité, la plus longue (esquisse la plus
 * aboutie).
 */
function reconcileNearDuplicateEdges(
  lines: LineCoords[],
  sourceEntities: string[] | undefined,
  info: NonNullable<PolygonizeOptions["nearDuplicateEdges"]> | undefined
): { lines: LineCoords[]; sourceEntities: string[] | undefined } {
  if (lines.length < 2) return { lines, sourceEntities };

  const keyOf = (x: number, y: number) =>
    Math.round(x / DUPLICATE_EDGE_VERTEX_EPS_M) + ":" + Math.round(y / DUPLICATE_EDGE_VERTEX_EPS_M);

  interface Endpoint {
    line: number;
    self: [number, number];
    other: [number, number];
  }
  const byVertex = new Map<string, Endpoint[]>();
  const addEndpoint = (line: number, self: number[], other: number[]) => {
    const k = keyOf(self[0], self[1]);
    const rec: Endpoint = { line, self: [self[0], self[1]], other: [other[0], other[1]] };
    const arr = byVertex.get(k);
    if (arr) arr.push(rec);
    else byVertex.set(k, [rec]);
  };
  lines.forEach((l, i) => {
    if (l.length < 2) return;
    addEndpoint(i, l[0], l[l.length - 1]);
    addEndpoint(i, l[l.length - 1], l[0]);
  });

  // Un point est "ancré" s'il coïncide (même clé) avec l'extrémité d'une AUTRE ligne.
  const isAnchored = (pt: [number, number], excludeLine: number): boolean =>
    (byVertex.get(keyOf(pt[0], pt[1])) ?? []).some((e) => e.line !== excludeLine);

  const lineLength = (i: number): number => {
    const l = lines[i];
    const a = l[0], b = l[l.length - 1];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };

  // Garde-fou : un sommet portant des dizaines de lignes n'est jamais une
  // vraie topologie cadastrale (angle mort MTEXT/point dégénéré, § 28 bis) —
  // la comparaison par paires y explique une part disproportionnée du coût
  // pour zéro doublon plausible. Écarté du dédoublonnage, pas du réseau.
  const MAX_CLUSTER_SIZE = 20;

  const drop = new Set<number>();
  const decidedPairs = new Set<string>();
  for (const entries of byVertex.values()) {
    if (entries.length < 2 || entries.length > MAX_CLUSTER_SIZE) continue;
    for (let a = 0; a < entries.length; a++) {
      if (drop.has(entries[a].line)) continue;
      for (let b = a + 1; b < entries.length; b++) {
        const A = entries[a], B = entries[b];
        if (A.line === B.line || drop.has(B.line)) continue;
        const pairKey = A.line < B.line ? `${A.line}_${B.line}` : `${B.line}_${A.line}`;
        if (decidedPairs.has(pairKey)) continue;

        const dx = A.other[0] - B.other[0];
        const dy = A.other[1] - B.other[1];
        const gap = Math.sqrt(dx * dx + dy * dy);
        // Bouts libres confondus : doublon exact, déjà écarté par canonicalLineKey.
        if (gap <= 0) continue;

        const vx1 = A.other[0] - A.self[0], vy1 = A.other[1] - A.self[1];
        const vx2 = B.other[0] - B.self[0], vy2 = B.other[1] - B.self[1];
        const n1 = Math.hypot(vx1, vy1), n2 = Math.hypot(vx2, vy2);
        if (n1 === 0 || n2 === 0) continue;
        const cos = Math.min(1, Math.max(-1, (vx1 * vx2 + vy1 * vy2) / (n1 * n2)));
        const angleDeg = (Math.acos(cos) * 180) / Math.PI;
        if (angleDeg > DUPLICATE_EDGE_MAX_ANGLE_DEG) continue;

        // Critère 1 : bouts libres proches — deux copies ~même longueur.
        const closeFarEnds = gap <= DUPLICATE_EDGE_MAX_GAP_M;

        // Critère 2 : re-tracé partiel — le bout libre de la copie
        // la plus courte est posé sur le segment de la plus longue (une des deux
        // s'arrête plus tôt, sur la même droite). Écarte le quasi-égal (géré par
        // le critère 1 / canonicalLineKey).
        const lenA = lineLength(A.line);
        const lenB = lineLength(B.line);
        const aShorter = lenA <= lenB;
        const shortEnd = aShorter ? A : B;
        const longLine = lines[aShorter ? B.line : A.line];
        const onLongSegment =
          Math.abs(lenA - lenB) > DUPLICATE_EDGE_ON_SEGMENT_EPS_M &&
          pointToSegmentDistance(
            shortEnd.other,
            longLine[0] as [number, number],
            longLine[longLine.length - 1] as [number, number]
          ) <= DUPLICATE_EDGE_ON_SEGMENT_EPS_M;

        if (!closeFarEnds && !onLongSegment) continue;

        decidedPairs.add(pairKey);
        let toDrop: number;
        if (onLongSegment && !closeFarEnds) {
          // Copie courte géométriquement incluse dans la longue : la retirer ne
          // peut enlever aucune information — on ignore l'heuristique d'ancrage.
          toDrop = aShorter ? A.line : B.line;
        } else {
          const aAnchored = isAnchored(A.other, A.line);
          const bAnchored = isAnchored(B.other, B.line);
          toDrop =
            aAnchored !== bAnchored
              ? aAnchored ? B.line : A.line
              : lenA >= lenB ? B.line : A.line;
        }
        drop.add(toDrop);
        if (info) {
          info.push({
            keptIndex: toDrop === A.line ? B.line : A.line,
            droppedIndex: toDrop,
            farGapM: gap,
            angleDeg,
          });
        }
      }
    }
  }

  if (drop.size === 0) return { lines, sourceEntities };
  console.info(`[polygonize] ${drop.size} arête(s) quasi-doublon(s) réconciliée(s) avant noding (§ 53 quater).`);
  const outLines: LineCoords[] = [];
  const outSrc: string[] | undefined = sourceEntities ? [] : undefined;
  lines.forEach((l, i) => {
    if (drop.has(i)) return;
    outLines.push(l);
    if (outSrc && sourceEntities) outSrc.push(sourceEntities[i]);
  });
  return { lines: outLines, sourceEntities: outSrc };
}

export function polygonizeLines(
  lines: LineCoords[],
  options: PolygonizeOptions = {}
): GeoJSON.Polygon[] {
  const minArea = options.minAreaM2 ?? 1;
  const maxArea = options.maxAreaM2 ?? Infinity;
  const tileThreshold = options.tileThreshold ?? TILE_THRESHOLD;
  const snapTol = options.snapToleranceM ?? SNAP_TOLERANCE_M;

  const srcIn = options.lineSourceEntities;
  const seenKeys = new Set<string>();
  const usable: LineCoords[] = [];
  // Lockstep avec `usable` (même index) — cf. § 53, `PolygonizeOptions.lineSourceEntities`.
  const usableSourceEntities: string[] = [];
  let duplicates = 0;
  lines.forEach((l, i) => {
    if (!Array.isArray(l) || l.length < 2) return;
    const key = canonicalLineKey(l);
    if (seenKeys.has(key)) {
      duplicates++;
      return;
    }
    seenKeys.add(key);
    usable.push(l);
    if (srcIn) usableSourceEntities.push(srcIn[i] ?? "?");
  });
  if (duplicates > 0) {
    console.info(`[polygonize] ${duplicates} ligne(s) dupliquée(s) écartée(s) avant noding.`);
  }
  if (usable.length === 0) return [];

  // § 53 quater : quasi-doublons (extrémité libre différente de quelques mètres),
  // distincts des doublons EXACTS déjà écartés ci-dessus.
  const reconciled = reconcileNearDuplicateEdges(
    usable,
    srcIn ? usableSourceEntities : undefined,
    options.nearDuplicateEdges
  );

  const stats: HealStats = {
    endpointsClustered: 0,
    endpointsSnapped: 0,
    droppedRegions: options.droppedRegions ?? [],
    dangles: options.dangles ?? [],
  };
  const finalLines = reconciled.lines;
  const finalSrc = reconciled.sourceEntities;
  const runTiled = () =>
    polygonizeTiled(
      finalLines,
      minArea,
      maxArea,
      options.tileTargetSegments ?? TILE_TARGET_SEGMENTS,
      options.tileMarginM ?? TILE_MARGIN_M,
      snapTol,
      stats,
      finalSrc
    );
  // La voie directe (≤ tileThreshold) n'a, contrairement à `polygonizeTiled`,
  // AUCUN filet de rattrapage (subdivision + retentative) sur un échec de
  // noding — un jeu de lignes fragile en dessous du seuil de tuilage faisait
  // planter tout l'appel plutôt que de dégrader proprement. Révélé en testant
  // § 53 quater à l'échelle réelle : le dédoublonnage AVANT noding retire assez
  // de lignes pour repasser sous `tileThreshold` sur certains fichiers
  // (Matam_Ourossogui.dxf, réseau limites de parcelles : 27 498 → 19 531
  // lignes), faisant basculer un fichier auparavant protégé par le tuilage
  // vers la voie directe non protégée, qui plantait sur une intersection non
  // nodée préexistante dans le fichier (sans rapport avec le dédoublonnage
  // lui-même). Repli sur `polygonizeTiled` — qui traite alors tout l'ensemble
  // comme une seule région et la subdivise déjà en cas d'échec — plutôt que de
  // relever `tileThreshold` (qui ne ferait que déplacer la même faille vers un
  // fichier un peu plus gros).
  const result = (() => {
    if (finalLines.length > tileThreshold) return runTiled();
    try {
      return polygonizeChunk(finalLines, minArea, maxArea, undefined, snapTol, stats, finalSrc);
    } catch (err) {
      console.warn(
        `[polygonize] union directe échouée (${finalLines.length} lignes) — repli sur le tuilage/subdivision robuste :`,
        err
      );
      return runTiled();
    }
  })();

  if (stats.endpointsClustered > 0 || stats.endpointsSnapped > 0) {
    console.info(
      `[polygonize] micro-trous raccordés (tol=${snapTol} m) : ` +
        `${stats.endpointsClustered} extrémité(s) regroupée(s), ` +
        `${stats.endpointsSnapped} raccrochée(s) à un segment/sommet` +
        (finalLines.length > tileThreshold ? " (occurrences par tuile, marges comprises)" : "")
    );
  }
  if (stats.dangles.length > 0) {
    const totalLengthM = stats.dangles.reduce((s, d) => s + d.lengthM, 0);
    // Répartition par écart d'auto-fermeture (cf. commentaire `selfGapM` dans
    // `polygonizeChunk`) : distingue les candidats sûrs pour une fermeture
    // dédiée (petit écart, cf. § 53) du reste (chaînes réellement ouvertes,
    // ou dangle né d'un fragment issu du noding avec d'autres lignes — pas
    // un écart d'auto-fermeture significatif dans ce cas).
    const buckets = [0.5, 1, 2, 5, 10, Infinity];
    const labels = ["≤0.5m", "0.5-1m", "1-2m", "2-5m", "5-10m", ">10m"];
    const counts = new Array(buckets.length).fill(0);
    for (const d of stats.dangles) {
      const i = buckets.findIndex((b) => d.selfGapM <= b);
      counts[i >= 0 ? i : buckets.length - 1]++;
    }
    const histogram = labels.map((l, i) => `${l}=${counts[i]}`).join(", ");
    // Type source EXACT (`_dgid_source_entity`, "?" = pas de correspondance
    // exacte — cf. `roundedLineKey`) — remplace le proxy `numVertices` par un
    // décompte par type réel, trié décroissant.
    const bySource = new Map<string, number>();
    for (const d of stats.dangles) bySource.set(d.sourceEntity, (bySource.get(d.sourceEntity) ?? 0) + 1);
    const sourceBreakdown = [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
    // Même répartition, limitée aux candidats sûrs (écart ≤ 2 m).
    const surs = stats.dangles.filter((d) => d.selfGapM <= 2);
    const bySourceSurs = new Map<string, number>();
    for (const d of surs) bySourceSurs.set(d.sourceEntity, (bySourceSurs.get(d.sourceEntity) ?? 0) + 1);
    const sourceBreakdownSurs = [...bySourceSurs.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
    console.warn(
      `[polygonize] ${stats.dangles.length} segment(s) de limite resté(s) pendant(s) ` +
        `après raccord (tol=${snapTol} m), ${totalLengthM.toFixed(0)} m cumulés — ` +
        "aucun polygone reconstruit pour ces segments (§ 53)" +
        (finalLines.length > tileThreshold ? " (occurrences par tuile, marges comprises — surcompte possible)." : ".") +
        ` Écart 1er/dernier sommet : ${histogram}.` +
        ` Type source exact : ${sourceBreakdown}.` +
        ` Parmi les écarts ≤2m : ${sourceBreakdownSurs}.`
    );
  }
  return result;
}
