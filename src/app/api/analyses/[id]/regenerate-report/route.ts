import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey } from "@/lib/geo-storage";
import { analyzeGeoJSON, generateAIReport } from "@/lib/geo-engine";

type Params = Promise<{ id: string }>;

export async function POST(_req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const analysisId = parseInt(id);

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: { topologicalErrors: true },
  });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  const rawGeoJson = (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!rawGeoJson) return NextResponse.json({ error: "GeoJSON introuvable" }, { status: 400 });

  let parsed;
  try { parsed = JSON.parse(rawGeoJson); } catch { return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 }); }

  const result = analyzeGeoJSON(parsed);
  const aiReport = await generateAIReport(result, analysis.fileName);

  // Met aussi à jour summaryStats (conformeCount, etc.) en conservant les champs
  // hors moteur déjà présents (outOfSenegalCount, microstationReport…).
  const prevStats = (analysis.summaryStats as Record<string, unknown> | null) ?? {};
  const summaryStats = { ...prevStats, ...result.stats };

  await prisma.analysis.update({
    where: { id: analysisId },
    data: {
      aiReport,
      conformityScore: result.stats.conformityScore.toString(),
      summaryStats: summaryStats as object,
    },
  });

  return NextResponse.json({ success: true, aiReport });
}
