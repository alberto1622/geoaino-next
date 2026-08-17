import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildAnalysesShapefileZip } from "@/lib/cadastre/export-shapefile";

// POST /api/cadastre/export/shapefile/analyses  body: { analysisIds: number[] }
// Export non destructif (lecture seule) — pas de rôle ADMIN requis, comme
// /api/cadastre/export/shapefile/multi.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { analysisIds?: unknown };
  const analysisIds = Array.isArray(body.analysisIds)
    ? body.analysisIds.filter((id): id is number => Number.isInteger(id))
    : [];
  if (analysisIds.length === 0) {
    return NextResponse.json({ error: "Liste de fichiers vide" }, { status: 400 });
  }

  const result = await buildAnalysesShapefileZip(analysisIds);
  if (!result) {
    return NextResponse.json({ error: "Aucune parcelle trouvée pour les fichiers sélectionnés" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
