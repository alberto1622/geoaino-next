import { existsSync } from "fs";
import { DatabaseSync } from "node:sqlite";

/**
 * basemap-tiles.ts — lecture des tuiles vectorielles du fond de carte local
 * (fichier MBTiles OpenMapTiles généré par Planetiler, cf.
 * docs/CONCEPTS-TRAITEMENT-DXF.md « Fond de carte local »).
 *
 * Le chemin vient UNIQUEMENT de `BASEMAP_MBTILES_PATH`, lue à l'exécution :
 * pas de repli `path.join(process.cwd(), …)`, qui ferait balayer tout le
 * projet par le traceur de fichiers de Next (cf. next.config.ts). Variable
 * absente ou fichier introuvable → fond local indisponible, le client
 * retombe sur les tuiles OSM publiques.
 *
 * `node:sqlite` (intégré à Node ≥ 22, et au Node d'Electron) plutôt que le
 * module natif `sqlite3` : rien à compiler ni à empaqueter pour le bureau.
 */

let db: DatabaseSync | null | undefined;

function openDb(): DatabaseSync | null {
  if (db !== undefined) return db;
  const file = process.env.BASEMAP_MBTILES_PATH;
  if (!file || !existsSync(file)) {
    db = null;
    return db;
  }
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    console.error("[basemap] ouverture MBTiles impossible", err);
    db = null;
  }
  return db;
}

export function isBasemapAvailable(): boolean {
  return openDb() !== null;
}

/**
 * Tuile `z/x/y` (schéma XYZ du client). Le MBTiles stocke les lignes en TMS
 * (origine en bas) : `tile_row = 2^z - 1 - y`. Renvoie `null` si la tuile
 * n'existe pas (zone vide, hors emprise) — à servir comme réponse vide.
 */
export function getBasemapTile(z: number, x: number, y: number): Uint8Array | null {
  const d = openDb();
  if (!d) return null;
  const row = (1 << z) - 1 - y;
  const res = d
    .prepare("SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?")
    .get(z, x, row) as { tile_data: Uint8Array } | undefined;
  return res?.tile_data ?? null;
}
