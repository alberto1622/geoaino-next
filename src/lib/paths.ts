import os from "os";
import path from "path";

/**
 * Répertoire utilisateur accessible en écriture pour les fichiers générés à
 * l'exécution (uploads, geojson temporaires, etc.).
 *
 * Dans un build installé sous `C:\Program Files\...`, `process.cwd()` pointe
 * dans un dossier protégé par Windows → EPERM sur mkdir. On préfère donc
 * `%LOCALAPPDATA%` (Windows) ou `~/Library/...` (macOS) ou `~/.config` (Linux).
 */
export function getUserDataDir(): string {
  const base =
    process.env.GEOAINO_DATA_DIR ??
    process.env.LOCALAPPDATA ??
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  return path.join(base, "GeoAino");
}

export function getUserUploadDir(): string {
  return path.join(getUserDataDir(), "uploads");
}
