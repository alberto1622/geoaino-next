import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import MapAnalysisClient from "@/components/MapAnalysisClient";

type Params = Promise<{ analysisId: string }>;

// Plafond d'erreurs embarquées dans le payload de la page (liste + overlay carte).
// Une analyse issue d'un gros DXF peut porter 100k+ erreurs (ex. NICAD manquants) :
// toutes les sérialiser avec leur géométrie fige le navigateur. On borne le rendu ;
// le compteur total (`errorCount`) reste exact et affiché.
const ERROR_RENDER_LIMIT = 2000;

export default async function MapAnalysisPage({ params }: { params: Params }) {
  const session = await auth();
  const { analysisId } = await params;
  const id = parseInt(analysisId);

  const analysis = await prisma.analysis.findUnique({
    where: { id },
    include: { topologicalErrors: { orderBy: { severity: "asc" }, take: ERROR_RENDER_LIMIT } },
  });

  if (!analysis) notFound();

  const errorsTruncated = (analysis.errorCount ?? 0) > analysis.topologicalErrors.length;

  // Tier 2 : le GeoJSON brut n'est plus embarqué dans le payload RSC ; le client
  // le récupère via /api/analyses/[id]/geojson (fetch + gzip + parse unique).
  const summaryStats = analysis.summaryStats as { outOfSenegalCount?: number; conformeCount?: number } | null;

  const serialized = {
    id: analysis.id,
    fileName: analysis.fileName,
    fileFormat: analysis.fileFormat,
    status: analysis.status,
    totalFeatures: analysis.totalFeatures,
    errorCount: analysis.errorCount,
    outOfSenegalCount: summaryStats?.outOfSenegalCount ?? 0,
    conformeCount: summaryStats?.conformeCount ?? null,
    conformityScore: Number(analysis.conformityScore),
    commune: analysis.commune,
    region: analysis.region,
    crs: analysis.crs,
    aiReport: analysis.aiReport,
    correctedData: analysis.correctedData,
    createdAt: analysis.createdAt.toISOString(),
    // Vrai si le nombre d'erreurs dépasse le plafond de rendu (liste/overlay tronqués).
    errorsTruncated,
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
