import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildSectionsShapefileZip } from "@/lib/cadastre/export-shapefile";

export const runtime = "nodejs";

/**
 * GET /api/cadastre/sections/export[?sourceFichier=...] — shapefile ZIP
 * (.shp/.shx/.dbf/.prj, WGS84) des limites de sections stockées, corrections
 * de chevauchements incluses. `sourceFichier` peut être répété (export de
 * plusieurs lots sélectionnés à la fois) ; sans lui, exporte tous les lots.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const sourceFichierList = req.nextUrl.searchParams.getAll("sourceFichier");
  const sourceFichier = sourceFichierList.length > 0 ? sourceFichierList : null;
  try {
    const result = await buildSectionsShapefileZip(sourceFichier);
    if (!result) {
      return NextResponse.json({ error: "Aucune section à exporter" }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
      },
    });
  } catch (err) {
    console.error("[cadastre/sections/export] GET", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
