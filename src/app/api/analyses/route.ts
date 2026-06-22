import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { analyzeGeoJSON, generateAIReport } from "@/lib/geo-engine";
import { saveGeoJsonLocally } from "@/lib/geo-storage";
import { filterOutOfSenegal } from "@/lib/senegal-bounds";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get("limit") ?? "20");
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const [rows, total] = await Promise.all([
    prisma.analysis.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        _count: { select: { topologicalErrors: true } },
      },
    }),
    prisma.analysis.count(),
  ]);

  const errorsByType = await prisma.topologicalError.groupBy({
    by: ["analysisId", "errorType"],
    _count: true,
    where: { analysisId: { in: rows.map((r) => r.id) } },
  });

  const errMap: Record<number, Record<string, number>> = {};
  for (const row of errorsByType) {
    if (!errMap[row.analysisId]) errMap[row.analysisId] = {};
    errMap[row.analysisId][row.errorType] = row._count;
  }

  return NextResponse.json({
    analyses: rows.map((r) => ({ ...r, errorsByType: errMap[r.id] ?? {} })),
    total,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id ?? undefined;

  const body = await req.json();
  const { fileName, fileFormat, fileSize, geoJsonData, adminBoundaryData, commune, region, microstationReport } = body;

  if (!geoJsonData) {
    return NextResponse.json({ error: "geoJsonData est requis" }, { status: 400 });
  }

  let geoJson: { type: string; features: unknown[] };
  try {
    geoJson = JSON.parse(geoJsonData);
  } catch {
    return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 });
  }

  let adminBoundary: { type: string; features: unknown[] } | undefined;
  if (adminBoundaryData) {
    try { adminBoundary = JSON.parse(adminBoundaryData); } catch { /* ignore */ }
  }

  const { kept: filteredGeoJson, removedCount: outOfSenegalCount } = filterOutOfSenegal(
    geoJson as { type: string; features: unknown[] } & { features: { type: string; geometry: { type: string; coordinates: unknown } | null; properties?: Record<string, unknown> | null }[] }
  );
  if (outOfSenegalCount > 0) {
    console.warn(`[analyses] ${outOfSenegalCount} entité(s) hors des limites du Sénégal écartée(s) de "${fileName}"`);
  }

  const geojsonKey = await saveGeoJsonLocally(fileName, JSON.stringify(filteredGeoJson), userId);

  const analysis = await prisma.analysis.create({
    data: {
      userId,
      fileName,
      fileFormat,
      fileSize: fileSize ? BigInt(fileSize) : null,
      status: "PROCESSING",
      commune: commune ?? null,
      region: region ?? null,
      geoJsonData: JSON.stringify({ type: "FeatureCollection", features: [] }),
      geojsonKey,
    },
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = analyzeGeoJSON(filteredGeoJson as any, adminBoundary as any);
    const aiReport = await generateAIReport(result, fileName);

    if (result.errors.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < result.errors.length; i += BATCH) {
        const batch = result.errors.slice(i, i + BATCH).map((e) => ({
          analysisId: analysis.id,
          errorType: e.type.toUpperCase() as "OVERLAP" | "GAP" | "SLIVER" | "DUPLICATE" | "INVALID_GEOM" | "BOUNDARY_CROSS" | "MISSING_NICAD" | "SELF_INTERSECT",
          severity: e.severity.toUpperCase() as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
          nicad1: e.nicad1 ?? null,
          nicad2: e.nicad2 ?? null,
          description: e.description,
          geometry: e.geometry ?? undefined,
          area: e.area != null ? e.area.toString() : null,
          confidence: String(e.confidence),
        }));
        await prisma.topologicalError.createMany({ data: batch });
      }
    }

    const stats = {
      ...result.stats,
      outOfSenegalCount,
      ...(microstationReport ? { microstationReport } : {}),
    };

    const updated = await prisma.analysis.update({
      where: { id: analysis.id },
      data: {
        status: "COMPLETED",
        totalFeatures: result.totalFeatures,
        errorCount: result.errors.length,
        conformityScore: result.stats.conformityScore.toString(),
        summaryStats: stats as object,
        aiReport,
      },
    });

    return NextResponse.json({
      id: updated.id,
      status: "completed",
      totalFeatures: result.totalFeatures,
      errorCount: result.errors.length,
      conformityScore: result.stats.conformityScore,
      stats,
      aiReport,
    });
  } catch (err) {
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { status: "FAILED" },
    });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
