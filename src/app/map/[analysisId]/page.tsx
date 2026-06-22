import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import MapAnalysisClient from "@/components/MapAnalysisClient";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";

type Params = Promise<{ analysisId: string }>;

export default async function MapAnalysisPage({ params }: { params: Params }) {
  const session = await auth();
  const { analysisId } = await params;
  const id = parseInt(analysisId);

  const analysis = await prisma.analysis.findUnique({
    where: { id },
    include: { topologicalErrors: { orderBy: { severity: "asc" } } },
  });

  if (!analysis) notFound();

  const loaded = await loadGeoJsonFromKey(analysis.geojsonKey);
  const geoJsonData = loaded ?? analysis.geoJsonData;

  const summaryStats = analysis.summaryStats as { outOfSenegalCount?: number } | null;

  const serialized = {
    id: analysis.id,
    fileName: analysis.fileName,
    fileFormat: analysis.fileFormat,
    status: analysis.status,
    totalFeatures: analysis.totalFeatures,
    errorCount: analysis.errorCount,
    outOfSenegalCount: summaryStats?.outOfSenegalCount ?? 0,
    conformityScore: Number(analysis.conformityScore),
    commune: analysis.commune,
    region: analysis.region,
    crs: analysis.crs,
    aiReport: analysis.aiReport,
    correctedData: analysis.correctedData,
    geoJsonData: geoJsonData ?? null,
    createdAt: analysis.createdAt.toISOString(),
    errors: analysis.topologicalErrors.map((e) => ({
      id: e.id,
      errorType: e.errorType,
      severity: e.severity,
      nicad1: e.nicad1,
      nicad2: e.nicad2,
      description: e.description,
      geometry: e.geometry,
      area: e.area ? Number(e.area) : null,
      confidence: Number(e.confidence),
      corrected: e.corrected,
    })),
  };

  return <MapAnalysisClient user={session?.user ?? null} analysis={serialized} />;
}
