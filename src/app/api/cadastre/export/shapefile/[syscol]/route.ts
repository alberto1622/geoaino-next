import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildShapefileZip } from "@/lib/cadastre/export-shapefile";

// GET /api/cadastre/export/shapefile/:syscol → ZIP shapefile d'une commune
export async function GET(_req: Request, ctx: { params: Promise<{ syscol: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const { syscol } = await ctx.params;
  const result = await buildShapefileZip(syscol);
  if (!result) {
    return NextResponse.json(
      { error: `Aucune parcelle trouvée pour le Syscol ${syscol.padStart(8, "0")}` },
      { status: 404 },
    );
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
