import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildMigrationExportShapefileZip } from "@/lib/cadastre/export-shapefile";

// POST /api/cadastre/export/shapefile/migration  body: { jobId: number }
// Export non destructif (lecture seule) — pas de rôle ADMIN requis, comme
// /api/cadastre/export/shapefile/analyses.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { jobId?: unknown };
  const jobId = Number.isInteger(body.jobId) ? (body.jobId as number) : null;
  if (!jobId) {
    return NextResponse.json({ error: "Identifiant de job invalide" }, { status: 400 });
  }

  const result = await buildMigrationExportShapefileZip(jobId);
  if (!result) {
    return NextResponse.json(
      { error: "Rapport de migration introuvable, incomplet, ou aucune parcelle exploitable" },
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
