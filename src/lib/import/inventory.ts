/**
 * inventory.ts — inventaire des calques d'un DXF avant import (variante
 * « simple » du mappage des calques).
 *
 * Lit un DXF (buffer déjà converti si la source était un DGN) et agrège les
 * calques distincts : nom, nombre d'entités, natures géométriques, et une
 * classe DGID PROPOSÉE (`proposeClassForLayer`). L'interface présente ce tableau
 * à l'utilisateur pour qu'il confirme/corrige le rattachement de chaque calque
 * à une classe du processus NICAD (limites_parcelles, numero_parcelle, …) avant
 * de lancer le traitement.
 *
 * La clé `layer` est le nom NORMALISÉ (`normalizeText`) : c'est cette clé qui
 * sert de clé de `LayerMapping` côté ingestion (`filterDxfCadastralFeatures`).
 */
import {
  normalizeText,
  normalizeFeatureCollection,
  proposeClassForLayer,
  type CadastralClass,
} from "../cadastral-filter";
import { readDxfWorldFeatures } from "../dxf-native";
import { convertDxfToFc32628 } from "../parcelle-ingestion";

export interface LayerInventoryEntry {
  /** Nom de calque normalisé (clé de mappage). */
  layer: string;
  /** Nom de calque brut (affichage), premier rencontré pour ce calque normalisé. */
  rawLayer: string;
  /** Nombre d'entités portées par ce calque. */
  count: number;
  /** Natures géométriques présentes (LineString, Polygon, Point…). */
  geometryKinds: string[];
  /** Classe DGID proposée automatiquement (`null` = à ignorer par défaut). */
  proposedClass: CadastralClass | null;
  /** Origine de la proposition : correspondance de nom, flou, ou aucune. */
  method: "alias" | "fuzzy" | "none";
}

function layerNameOf(props: Record<string, unknown> | null | undefined): string {
  const p = props || {};
  return String(
    p.Layer ?? p.layer ?? p.Level ?? p.LEVEL ?? p.Niveau ?? p.niveau ?? p.Calque ?? p.calque ?? "",
  ).trim();
}

/**
 * Construit l'inventaire des calques d'une FeatureCollection (issue de la
 * lecture DXF native ou d'ogr2ogr). Trie par classe proposée puis par volume.
 */
export function buildLayerInventory(
  fc: GeoJSON.FeatureCollection,
): LayerInventoryEntry[] {
  const byKey = new Map<
    string,
    { rawLayer: string; count: number; kinds: Set<string> }
  >();

  for (const feature of fc.features || []) {
    if (!feature || !feature.geometry) continue;
    const rawLayer = layerNameOf(feature.properties as Record<string, unknown> | null);
    const key = normalizeText(rawLayer);
    if (!key) continue; // calque illisible : ignoré de l'inventaire
    const entry = byKey.get(key);
    if (entry) {
      entry.count += 1;
      entry.kinds.add(feature.geometry.type);
    } else {
      byKey.set(key, {
        rawLayer: rawLayer || key,
        count: 1,
        kinds: new Set([feature.geometry.type]),
      });
    }
  }

  const entries: LayerInventoryEntry[] = Array.from(byKey.entries()).map(([layer, v]) => {
    const proposal = proposeClassForLayer(layer);
    return {
      layer,
      rawLayer: v.rawLayer,
      count: v.count,
      geometryKinds: Array.from(v.kinds).sort(),
      proposedClass: proposal?.cls ?? null,
      method: proposal?.method ?? "none",
    };
  });

  // Calques reconnus d'abord (proposition non nulle), puis par volume décroissant.
  entries.sort((a, b) => {
    const ra = a.proposedClass ? 0 : 1;
    const rb = b.proposedClass ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return b.count - a.count;
  });

  return entries;
}

/**
 * Lit un buffer DXF en FeatureCollection pour l'inventaire : lecteur natif
 * (déplie les blocs INSERT des DXF issus d'une conversion DGN/Microstation)
 * avec repli sur ogr2ogr si le natif ne produit rien.
 */
export async function readDxfToFeatureCollection(
  dxfBuffer: Buffer,
  fileName: string,
): Promise<GeoJSON.FeatureCollection> {
  try {
    const nativeFc = readDxfWorldFeatures(dxfBuffer);
    if (nativeFc.features.length > 0) return nativeFc;
  } catch (err) {
    console.warn("[import/inventory] lecteur DXF natif échoué, repli ogr2ogr:", err);
  }
  const fc = await convertDxfToFc32628(dxfBuffer, fileName);
  return normalizeFeatureCollection(fc) as unknown as GeoJSON.FeatureCollection;
}
