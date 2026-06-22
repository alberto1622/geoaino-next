import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";
import AnalysisTableClient from "@/components/AnalysisTableClient";

type Params = Promise<{ analysisId: string }>;

export default async function AnalysisTablePage({ params }: { params: Params }) {
  const session = await auth();
  const { analysisId } = await params;
  const id = parseInt(analysisId);

  const analysis = await prisma.analysis.findUnique({
    where: { id },
    select: {
      id: true,
      fileName: true,
      fileFormat: true,
      totalFeatures: true,
      errorCount: true,
      conformityScore: true,
      commune: true,
      region: true,
      geojsonKey: true,
      geoJsonData: true,
      topologicalErrors: {
        select: { nicad1: true, errorType: true, severity: true },
      },
    },
  });

  if (!analysis) notFound();

  const geoJsonData = (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;

  const errorIndex: Record<string, { errorType: string; severity: string }[]> = {};
  for (const e of analysis.topologicalErrors) {
    if (!e.nicad1) continue;
    if (!errorIndex[e.nicad1]) errorIndex[e.nicad1] = [];
    errorIndex[e.nicad1].push({ errorType: e.errorType, severity: e.severity });
  }

  return (
    <AnalysisTableClient
      user={session?.user ?? null}
      analysis={{
        id: analysis.id,
        fileName: analysis.fileName,
        fileFormat: analysis.fileFormat,
        totalFeatures: analysis.totalFeatures,
        errorCount: analysis.errorCount,
        conformityScore: Number(analysis.conformityScore),
        commune: analysis.commune,
        region: analysis.region,
        geoJsonData: geoJsonData ?? null,
      }}
      errorIndex={errorIndex}
    />
  );
}
