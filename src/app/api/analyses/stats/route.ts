import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [stats] = await prisma.$queryRaw<
    Array<{
      totalAnalyses: bigint;
      totalParcelles: bigint;
      totalErrors: bigint;
      avgConformity: number;
    }>
  >`
    SELECT
      COUNT(*) as "totalAnalyses",
      COALESCE(SUM("totalFeatures"), 0) as "totalParcelles",
      COALESCE(SUM("errorCount"), 0) as "totalErrors",
      COALESCE(AVG(CAST("conformityScore" AS FLOAT)), 0) as "avgConformity"
    FROM "Analysis"
  `;

  const errorsByType = await prisma.topologicalError.groupBy({
    by: ["errorType"],
    _count: true,
  });

  const recentAnalyses = await prisma.analysis.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return NextResponse.json({
    totalAnalyses: Number(stats.totalAnalyses),
    totalParcelles: Number(stats.totalParcelles),
    totalErrors: Number(stats.totalErrors),
    avgConformity: Math.round(Number(stats.avgConformity) * 10) / 10,
    errorsByType: Object.fromEntries(errorsByType.map((e) => [e.errorType, e._count])),
    recentAnalyses,
  });
}
