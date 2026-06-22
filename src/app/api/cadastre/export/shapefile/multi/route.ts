import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildShapefileMultiZip } from "@/lib/cadastre/export-shapefile";

// POST /api/cadastre/export/shapefile/multi  body: { syscols: string[] }
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { syscols?: string[] };
  const syscols = Array.isArray(body.syscols) ? body.syscols : [];
  if (syscols.length === 0) {
    return NextResponse.json({ error: "Liste de Syscols vide" }, { status: 400 });
  }

  const result = await buildShapefileMultiZip(syscols);
  if (!result) {
    return NextResponse.json({ error: "Aucune parcelle trouvée pour les Syscols fournis" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
    },
  });
}
