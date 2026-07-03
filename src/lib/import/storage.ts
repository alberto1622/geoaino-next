/**
 * storage.ts — persistance du fichier source d'un import (binaire).
 *
 * Le job d'import s'exécutant *après* la réponse HTTP, le buffer uploadé ne peut
 * pas rester en mémoire de la requête : on l'écrit sur disque et on stocke sa
 * clé (`local:<chemin>`) dans `cad_import_jobs.fileKey`. Même convention de
 * préfixe que `geo-storage.ts`.
 */
import { promises as fs } from "fs";
import path from "path";

const UPLOAD_DIR =
  process.env.IMPORT_UPLOADS_DIR ?? path.join(process.cwd(), "uploads", "imports");

const LOCAL_PREFIX = "local:";

function sanitize(fileName: string): string {
  return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Écrit le fichier source uploadé et retourne sa clé `local:<chemin>`. */
export async function saveImportUpload(fileName: string, data: Buffer): Promise<string> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const finalName = `${Date.now()}_${sanitize(fileName)}`;
  const fullPath = path.join(UPLOAD_DIR, finalName);
  await fs.writeFile(fullPath, data);
  return `${LOCAL_PREFIX}${fullPath}`;
}

/** Relit le buffer du fichier source à partir de sa clé. */
export async function loadImportUpload(key: string): Promise<Buffer> {
  const filePath = key.startsWith(LOCAL_PREFIX) ? key.slice(LOCAL_PREFIX.length) : key;
  return fs.readFile(filePath);
}

/** Supprime le fichier source (nettoyage post-import). */
export async function deleteImportUpload(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const filePath = key.startsWith(LOCAL_PREFIX) ? key.slice(LOCAL_PREFIX.length) : key;
  try {
    await fs.unlink(filePath);
  } catch {
    // déjà supprimé / introuvable — ignorer
  }
}
