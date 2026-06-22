import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, deleteGeoJsonByKey } from "@/lib/geo-storage";

type Params = Promise<{ id: string }>;

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const analysisId = parseInt(id);

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: { topologicalErrors: { orderBy: { severity: "asc" } } },
  });

  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  const loaded = await loadGeoJsonFromKey(analysis.geojsonKey);
  const geoJsonData = loaded ?? analysis.geoJsonData;

  return NextResponse.json({ ...analysis, geoJsonData });
}

export async function DELETE(_req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const analysisId = parseInt(id);

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: {
      _count: {
        select: {
          topologicalErrors: true,
          reports: true,
          aiConversations: true,
          overlapGeometries: true,
          geoEngineResults: true,
          geoprocessingOps: true,
        },
      },
    },
  });

  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  // Suppression explicite dans l'ordre pour éviter les contraintes FK
  await prisma.$transaction([
    prisma.aiConversation.deleteMany({ where: { analysisId } }),
    prisma.geoprocessingOp.deleteMany({ where: { analysisId } }),
    prisma.geoEngineResult.deleteMany({ where: { analysisId } }),
    prisma.overlapGeometry.deleteMany({ where: { analysisId } }),
    prisma.topologicalError.deleteMany({ where: { analysisId } }),
    prisma.report.deleteMany({ where: { analysisId } }),
    prisma.analysis.delete({ where: { id: analysisId } }),
  ]);

  await deleteGeoJsonByKey(analysis.geojsonKey);

  return NextResponse.json({
    success: true,
    deleted: {
      fileName: analysis.fileName,
      errors: analysis._count.topologicalErrors,
      reports: analysis._count.reports,
      conversations: analysis._count.aiConversations,
    },
  });
}
