import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import DashboardClient from "@/components/DashboardClient";

export const metadata = { title: "Tableau de bord" };

type Period = "TODAY" | "WEEK" | "MONTH" | "ALL";

function getDateFrom(period: Period): Date | null {
  const now = new Date();
  if (period === "TODAY") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "WEEK") { const d = new Date(now); d.setDate(now.getDate() - 7); return d; }
  if (period === "MONTH") { const d = new Date(now); d.setMonth(now.getMonth() - 1); return d; }
  return null;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; analysisId?: string }>;
}) {
  const session = await auth();
  const { period = "ALL", analysisId } = await searchParams;
  const validPeriod = (["TODAY", "WEEK", "MONTH", "ALL"].includes(period) ? period : "ALL") as Period;
  const dateFrom = getDateFrom(validPeriod);
  const selectedId = analysisId ? parseInt(analysisId) : null;

  // Build where clause combining period + optional file filter
  const baseWhere = {
    ...(dateFrom ? { createdAt: { gte: dateFrom } } : {}),
    ...(selectedId ? { id: selectedId } : {}),
  };
  const errorWhere = {
    ...(dateFrom ? { analysis: { createdAt: { gte: dateFrom } } } : {}),
    ...(selectedId ? { analysisId: selectedId } : {}),
  };

  // All files for the dropdown (always unfiltered)
  const allFiles = await prisma.analysis.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, createdAt: true },
  });

  const [totalAnalyses, parcellesAgg, errorsAgg, avgAgg, recentAnalyses] = await Promise.all([
    prisma.analysis.count({ where: baseWhere }),
    prisma.analysis.aggregate({ where: baseWhere, _sum: { totalFeatures: true } }),
    prisma.analysis.aggregate({ where: baseWhere, _sum: { errorCount: true } }),
    prisma.analysis.aggregate({ where: baseWhere, _avg: { conformityScore: true } }),
    prisma.analysis.findMany({
      where: baseWhere,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, fileName: true, fileFormat: true, status: true,
        conformityScore: true, errorCount: true, totalFeatures: true,
        commune: true, region: true, createdAt: true,
      },
    }),
  ]);

  const errorsByType = await prisma.topologicalError.groupBy({
    by: ["errorType"],
    where: errorWhere,
    _count: true,
  });

  const trendData = await prisma.analysis.findMany({
    where: baseWhere,
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, conformityScore: true, errorCount: true, createdAt: true, fileName: true },
  });

  const stats = {
    totalAnalyses,
    totalParcelles: parcellesAgg._sum.totalFeatures ?? 0,
    totalErrors: errorsAgg._sum.errorCount ?? 0,
    avgConformity: Number(avgAgg._avg.conformityScore ?? 0),
    errorsByType: Object.fromEntries(errorsByType.map((e) => [e.errorType, e._count])),
    recentAnalyses: recentAnalyses.map((a) => ({
      ...a,
      conformityScore: Number(a.conformityScore),
      createdAt: a.createdAt.toISOString(),
    })) as Array<{
      id: number; fileName: string; fileFormat: string; status: string;
      conformityScore: number; errorCount: number | null;
      totalFeatures: number | null; commune: string | null; region: string | null; createdAt: string;
    }>,
    trendData: trendData.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      conformityScore: Number(a.conformityScore),
      errorCount: a.errorCount ?? 0,
      createdAt: a.createdAt.toISOString(),
    })).reverse(),
  };

  return (
    <DashboardClient
      user={session?.user ?? null}
      stats={stats}
      period={validPeriod}
      selectedAnalysisId={selectedId}
      allFiles={allFiles.map((f) => ({ id: f.id, fileName: f.fileName, createdAt: f.createdAt.toISOString() }))}
    />
  );
}
