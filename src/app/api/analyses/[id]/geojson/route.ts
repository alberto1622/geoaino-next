import { NextRequest } from "next/server";
import { promisify } from "util";
import { gzip } from "zlib";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";
import { requireSession } from "@/lib/analyses/require-session";

// zlib → runtime Node obligatoire (pas Edge)
export const runtime = "nodejs";

const gzipAsync = promisify(gzip);

type Params = Promise<{ id: string }>;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Sert le GeoJSON brut d'une analyse hors du payload RSC de la page.
 *
 * Tier 2 — optimisation d'affichage :
 *  - le fichier (jusqu'à plusieurs dizaines de Mo) ne transite plus dans le HTML
 *    initial mais est récupéré par le client via fetch (un seul parse navigateur) ;
 *  - compression gzip transparente (~10× sur du GeoJSON) quand le client la supporte.
 */
export async function GET(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const analysisId = parseInt(id);
  if (Number.isNaN(analysisId)) return jsonError("ID invalide", 400);

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { geojsonKey: true, geoJsonData: true },
  });
  if (!analysis) return jsonError("Analyse non trouvée", 404);

  const raw = (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!raw) return jsonError("Données GeoJSON introuvables", 404);

  const headers: Record<string, string> = {
    "Content-Type": "application/geo+json; charset=utf-8",
    // Données éditables (corrections, suppression d'entités) → cache court côté client.
    "Cache-Control": "private, max-age=30",
    Vary: "Accept-Encoding",
  };

  const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
  if (acceptsGzip) {
    const compressed = await gzipAsync(raw);
    headers["Content-Encoding"] = "gzip";
    return new Response(compressed, { headers });
  }

  return new Response(raw, { headers });
}
