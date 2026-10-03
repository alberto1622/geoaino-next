import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/analyses/require-session";
import { getBasemapTile } from "@/lib/basemap-tiles";

type Params = Promise<{ z: string; x: string; y: string }>;

const MAX_ZOOM = 14; // emprise du MBTiles Planetiler (au-delà : sur-zoom côté client)

/**
 * GET /api/tiles/{z}/{x}/{y} — tuile vectorielle (MVT) du fond de carte local.
 * Session requise comme le reste de l'application (les cartes sont toutes
 * derrière la connexion ; le cookie de session part avec les requêtes
 * MapLibre, de même origine). Tuile absente → 204 : MapLibre la traite comme
 * vide, sans erreur dans la console.
 */
export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const p = await params;
  const z = Number(p.z), x = Number(p.x), y = Number(p.y);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > MAX_ZOOM) {
    return NextResponse.json({ error: "Coordonnées de tuile invalides" }, { status: 400 });
  }
  const n = 1 << z;
  if (x < 0 || y < 0 || x >= n || y >= n) {
    return NextResponse.json({ error: "Coordonnées de tuile invalides" }, { status: 400 });
  }

  const data = getBasemapTile(z, x, y);
  if (!data) return new NextResponse(null, { status: 204 });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-protobuf",
    "Cache-Control": "private, max-age=86400",
  };
  // Planetiler stocke les tuiles compressées en gzip (en-tête 1f 8b).
  if (data[0] === 0x1f && data[1] === 0x8b) headers["Content-Encoding"] = "gzip";
  return new NextResponse(Buffer.from(data), { status: 200, headers });
}
