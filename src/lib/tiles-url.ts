/**
 * Tuiles raster OSM publiques : fond de REPLI uniquement, quand le fond local
 * (MBTiles servi par /api/tiles) n'est pas installé — cf. `basemap.ts`.
 *
 * L'ancienne bascule vers un tileserver local via `NEXT_PUBLIC_TILES_PORT`
 * ne fonctionnait pas : Next fige les variables `NEXT_PUBLIC_*` au build,
 * alors que le port n'était connu qu'au lancement du bureau.
 */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
