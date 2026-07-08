import { NextRequest, NextResponse } from "next/server";
import { getAdminBoundaries, type AdminLevel } from "@/lib/cadastre/admin-boundaries";

export const runtime = "nodejs";

const LEVELS = new Set<AdminLevel>(["regions", "departements", "communes"]);

/**
 * GET /api/cadastre/admin-boundaries?niveau=regions|departements|communes —
 * contours administratifs (simplifiés) + points d'étiquette (noms), dérivés de
 * `cad_communes_2026` (dissolution pour départements/régions). Cache serveur
 * en mémoire + cache HTTP (référentiel statique).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const niveau = req.nextUrl.searchParams.get("niveau") as AdminLevel | null;
  if (!niveau || !LEVELS.has(niveau)) {
    return NextResponse.json(
      { error: "Paramètre niveau requis : regions | departements | communes" },
      { status: 400 },
    );
  }
  try {
    const data = await getAdminBoundaries(niveau);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    console.error("[cadastre/admin-boundaries] GET", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
