import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAdminBoundaries, type AdminLevel } from "@/lib/cadastre/admin-boundaries";

export const runtime = "nodejs";

const LEVELS = new Set<AdminLevel>(["regions", "departements", "communes", "arrondissements"]);

/**
 * GET /api/cadastre/admin-boundaries?niveau=regions|departements|communes|arrondissements —
 * contours administratifs (simplifiés) + points d'étiquette (noms). Communes
 * et arrondissements ont leur propre géométrie ; départements/régions sont
 * dissous à la volée depuis `cad_communes_2026`. Cache serveur en mémoire +
 * cache HTTP (référentiel statique).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const niveau = req.nextUrl.searchParams.get("niveau") as AdminLevel | null;
  if (!niveau || !LEVELS.has(niveau)) {
    return NextResponse.json(
      { error: "Paramètre niveau requis : regions | departements | communes | arrondissements" },
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
