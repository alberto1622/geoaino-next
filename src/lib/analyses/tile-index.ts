/**
 * tile-index.ts — index de tuiles vectorielles (MVT) par analyse.
 *
 * Motivation : une analyse issue d'un gros DXF cadastral peut porter 100k+
 * parcelles. Envoyer tout le GeoJSON au navigateur (parse + rendu + clones)
 * sature la mémoire. On sert désormais des tuiles vectorielles : le fichier est
 * parsé UNE fois côté serveur en index `geojson-vt` (mis en cache), et
 * `getTile(z,x,y)` restitue à la demande uniquement la portion visible.
 *
 * Le cache est borné (LRU) : chaque index est volumineux, on n'en garde que
 * quelques-uns. La clé de fraîcheur est `updatedAt` de l'analyse (les
 * corrections regénèrent `correctedData` → invalidation).
 */
import geojsonvt from "geojson-vt";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";

type VtIndex = ReturnType<typeof geojsonvt>;
export type BBox = [number, number, number, number];

/** Membre d'un groupe de parcelles partageant le même NICAD (props + emprise). */
export type NicadGroupMember = Record<string, unknown> & { _bbox: BBox };

interface CacheEntry {
  index: VtIndex;
  /** Emprise globale (EPSG:4326) [w, s, e, n] ou `null` si aucune géométrie. */
  bbox: BBox | null;
  /** Emprise par NICAD (fit sur recherche/erreur sans embarquer les géométries). */
  nicadBounds: Map<string, BBox>;
  /**
   * Groupes de parcelles partageant un NICAD (uniquement les NICAD en doublon,
   * count > 1) : propriétés + emprise de chaque occurrence. Alimente la table
   * attributaire au clic sur une parcelle dupliquée, sans charger tout le FC.
   */
  nicadGroups: Map<string, NicadGroupMember[]>;
  /** Nombre de features indexées. */
  count: number;
  /** Empreinte de fraîcheur (updatedAt) pour invalider après corrections. */
  stamp: number;
}

const CACHE = new Map<number, CacheEntry>();
const MAX_ENTRIES = 3;

// Options geojson-vt : maxZoom élevé (parcelles minuscules visibles en zoom),
// buffer généreux (évite les coutures entre tuiles), extent MVT standard.
const VT_OPTIONS = { maxZoom: 20, indexMaxZoom: 5, tolerance: 3, extent: 4096, buffer: 64 } as const;

/** Nom de couche des tuiles vectorielles (côté client : `source-layer`). */
export const TILE_LAYER = "parcelles";

// Propriétés scalaires conservées dans les tuiles (les tuiles MVT ne supportent
// que string/number/bool — on écarte les tableaux comme `autres_textes`). Elles
// alimentent le popup au clic et les filtres de surlignage.
const KEEP_PROPS = [
  "nicad", "numero", "numero_parcelle", "numero_lot", "numero_section",
  "proprietaire", "denomination", "syscol", "commune_2026", "surface_m2", "is_piscine",
];

function extractNicad(p: Record<string, unknown>): string {
  return String(p.NICAD ?? p.nicad ?? p.NIC ?? p.Nicad ?? "");
}

/** Étend un accumulateur bbox avec les coordonnées d'une géométrie (récursif). */
function accumulateBBox(coords: unknown, acc: BBox): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    const [x, y] = coords as number[];
    if (x < acc[0]) acc[0] = x;
    if (y < acc[1]) acc[1] = y;
    if (x > acc[2]) acc[2] = x;
    if (y > acc[3]) acc[3] = y;
    return;
  }
  for (const c of coords) accumulateBBox(c, acc);
}

export function geometryBBox(geom: GeoJSON.Geometry | null): BBox | null {
  if (!geom || !("coordinates" in geom)) return null;
  const acc: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  accumulateBBox((geom as { coordinates: unknown }).coordinates, acc);
  return Number.isFinite(acc[0]) ? acc : null;
}

async function buildEntry(analysisId: number, stamp: number): Promise<CacheEntry | null> {
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { geojsonKey: true, geoJsonData: true, correctedData: true },
  });
  if (!analysis) return null;

  // Prime les corrections si présentes (le rendu doit refléter l'édition),
  // sinon le GeoJSON persisté sur disque, sinon le champ inline (legacy).
  const raw =
    analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!raw) return null;

  let parsed: GeoJSON.FeatureCollection;
  try {
    parsed = JSON.parse(raw) as GeoJSON.FeatureCollection;
  } catch {
    return null;
  }

  const nicadBounds = new Map<string, BBox>();
  const propsByNicad = new Map<string, NicadGroupMember[]>();
  const overall: BBox = [Infinity, Infinity, -Infinity, -Infinity];

  const features: GeoJSON.Feature[] = [];
  for (const feat of parsed.features ?? []) {
    if (!feat?.geometry) continue;
    const p = (feat.properties ?? {}) as Record<string, unknown>;
    const nicad = extractNicad(p);

    // Propriétés slim (scalaires) + _nicad pour les filtres de surlignage.
    const props: Record<string, unknown> = { _nicad: nicad };
    for (const k of KEEP_PROPS) {
      const v = p[k];
      if (v != null && typeof v !== "object") props[k] = v;
    }

    const b = geometryBBox(feat.geometry);
    if (b) {
      if (b[0] < overall[0]) overall[0] = b[0];
      if (b[1] < overall[1]) overall[1] = b[1];
      if (b[2] > overall[2]) overall[2] = b[2];
      if (b[3] > overall[3]) overall[3] = b[3];
      if (nicad && !nicadBounds.has(nicad)) nicadBounds.set(nicad, b);
    }

    if (nicad) {
      const member: NicadGroupMember = { ...props, _bbox: b ?? [0, 0, 0, 0] };
      const arr = propsByNicad.get(nicad);
      if (arr) arr.push(member);
      else propsByNicad.set(nicad, [member]);
    }

    features.push({ type: "Feature", geometry: feat.geometry, properties: props });
  }

  // Ne conserver que les NICAD réellement en doublon (borne la mémoire du cache).
  const nicadGroups = new Map<string, NicadGroupMember[]>();
  for (const [nicad, members] of propsByNicad) {
    if (members.length > 1) nicadGroups.set(nicad, members);
  }

  const index = geojsonvt({ type: "FeatureCollection", features }, VT_OPTIONS);
  const bbox: BBox | null = Number.isFinite(overall[0]) ? overall : null;

  return { index, bbox, nicadBounds, nicadGroups, count: features.length, stamp };
}

/**
 * Retourne l'entrée de cache (index + métadonnées) d'une analyse, en la
 * (re)construisant si absente ou périmée. `null` si l'analyse/les données sont
 * introuvables.
 */
export async function getTileEntry(analysisId: number): Promise<CacheEntry | null> {
  const meta = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { updatedAt: true },
  });
  if (!meta) return null;
  const stamp = meta.updatedAt.getTime();

  const hit = CACHE.get(analysisId);
  if (hit && hit.stamp === stamp) {
    CACHE.delete(analysisId); // rafraîchit l'ordre LRU
    CACHE.set(analysisId, hit);
    return hit;
  }

  const entry = await buildEntry(analysisId, stamp);
  if (!entry) return null;

  CACHE.set(analysisId, entry);
  while (CACHE.size > MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    CACHE.delete(oldest);
  }
  return entry;
}
