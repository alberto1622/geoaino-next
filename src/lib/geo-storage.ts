import { promises as fs } from "fs";
import path from "path";

function getLocalGeoJsonDir(): string {
  return process.env.LOCAL_GEOJSON_DIR ??
    path.join(process.cwd(), "uploads", "geojson");
}
const LOCAL_GEOJSON_DIR = getLocalGeoJsonDir();

const LOCAL_PREFIX = "local:";

export async function saveGeoJsonLocally(
  fileName: string,
  data: string,
  userId?: string | null
): Promise<string> {
  await fs.mkdir(LOCAL_GEOJSON_DIR, { recursive: true });
  const ts = Date.now();
  const safe = fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.zip$/i, ".geojson");
  const finalName = `${userId ?? "anon"}_${ts}_${safe.endsWith(".geojson") ? safe : safe + ".geojson"}`;
  const fullPath = `${LOCAL_GEOJSON_DIR}/${finalName}`.replace(/\\/g, "/");
  await fs.writeFile(fullPath, data, "utf8");
  return `${LOCAL_PREFIX}${fullPath}`;
}

export async function loadGeoJsonFromKey(
  key: string | null | undefined
): Promise<string | null> {
  if (!key) return null;
  const filePath = key.startsWith(LOCAL_PREFIX)
    ? key.slice(LOCAL_PREFIX.length)
    : key; // backward compat: raw paths stored before the prefix was introduced
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writeGeoJsonByKey(
  key: string,
  data: string
): Promise<void> {
  const filePath = key.startsWith(LOCAL_PREFIX)
    ? key.slice(LOCAL_PREFIX.length)
    : key;
  await fs.writeFile(filePath, data, "utf8");
}

export async function deleteGeoJsonByKey(
  key: string | null | undefined
): Promise<void> {
  if (!key) return;
  const filePath = key.startsWith(LOCAL_PREFIX)
    ? key.slice(LOCAL_PREFIX.length)
    : key;
  try {
    await fs.unlink(filePath);
  } catch {
    // already deleted or not found — ignore
  }
}
