import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import TopologyClient from "@/components/TopologyClient";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";

type Params = Promise<{ analysisId: string }>;

export default async function TopologyPage({ params }: { params: Params }) {
  const session = await auth();
  const { analysisId } = await params;
  const id = parseInt(analysisId);

  const analysis = await prisma.analysis.findUnique({
    where: { id },
    include: { topologicalErrors: { orderBy: [{ severity: "asc" }, { createdAt: "asc" }] } },
  });

  if (!analysis) notFound();

  const geoJsonData = (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;

  return (
    <TopologyClient
      user={session?.user ?? null}
      analysis={{
        id: analysis.id,
        fileName: analysis.fileName,
        totalFeatures: analysis.totalFeatures,
        errorCount: analysis.errorCount,
        conformityScore: Number(analysis.conformityScore),
        geoJsonData: geoJsonData ?? null,
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
      }}
    />
  );
}
