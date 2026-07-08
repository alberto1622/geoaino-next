import { NextResponse } from "next/server";
import { listSectionBatches } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/sections/batches — lots de sections déjà stockés
 * (`sourceFichier` + compteurs), pour réafficher les données au chargement de la
 * page /cadastre/sections sans réimporter.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const batches = await listSectionBatches();
    return NextResponse.json({ batches });
  } catch (err) {
    console.error("[cadastre/sections/batches] GET", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
