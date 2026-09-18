/**
 * Résout l'URL des tuiles de carte en mode desktop offline.
 * Si NEXT_PUBLIC_TILES_PORT est défini, utilise le serveur local (tileserver-gl).
 * Sinon, bascule sur le serveur public OpenStreetMap.
 */
export function getTileUrl(): string {
  const port = process.env.NEXT_PUBLIC_TILES_PORT;
  if (port) {
    // tileserver-gl sert les tuiles via /data/senegal/{z}/{x}/{y}.png
    return `http://127.0.0.1:${port}/data/senegal/{z}/{x}/{y}.png`;
  }
  // Fallback public (web)
  return `https://tile.openstreetmap.org/{z}/{x}/{y}.png`;
}

export function getTileUrlTemplate(): string {
  return getTileUrl().replace("{s}", "abc");
}
