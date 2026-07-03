import { promisify } from "util";
import { gzip } from "zlib";
import vtpbf from "vt-pbf";
import { getTileEntry, TILE_LAYER } from "@/lib/analyses/tile-index";

// geojson-vt / vt-pbf / zlib → runtime Node obligatoire (pas Edge).
export const runtime = "nodejs";

const gzipAsync = promisify(gzip);

type Params = Promise<{ id: string; z: string; x: string; y: string }>;

/**
 * GET /api/analyses/[id]/tiles/[z]/[x]/[y] — tuile vectorielle MVT des parcelles.
 *
 * Sert la portion visible d'une analyse volumineuse (100k+ parcelles) sans
 * embarquer tout le GeoJSON côté navigateur. L'index geojson-vt est construit
 * une fois puis mis en cache (`tile-index.ts`). Couche MVT : `parcelles`.
 */
export async function GET(_req: Request, { params }: { params: Params }) {
  const { id, z, x, y } = await params;
  const analysisId = parseInt(id, 10);
  const zi = parseInt(z, 10);
  const xi = parseInt(x, 10);
  const yi = parseInt(y, 10);
  if ([analysisId, zi, xi, yi].some((n) => Number.isNaN(n))) {
    return new Response("Paramètres de tuile invalides", { status: 400 });
  }

  const entry = await getTileEntry(analysisId);
  if (!entry) return new Response("Analyse introuvable", { status: 404 });

  const tile = entry.index.getTile(zi, xi, yi);
  // Tuile vide : 204 (MapLibre l'interprète comme « rien à afficher ici »).
  if (!tile || tile.features.length === 0) {
    return new Response(null, { status: 204 });
  }

  const buffer = Buffer.from(vtpbf.fromGeojsonVt({ [TILE_LAYER]: tile }, { version: 2 }));
  const compressed = await gzipAsync(buffer);

  return new Response(compressed, {
    headers: {
      "Content-Type": "application/x-protobuf",
      "Content-Encoding": "gzip",
      // Données éditables (corrections) → cache court côté client ; le cache
      // serveur (index) est invalidé via updatedAt.
      "Cache-Control": "private, max-age=30",
    },
  });
}
