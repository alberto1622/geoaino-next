import { auth } from "@/lib/auth";
import HomeClient from "@/components/HomeClient";
import { prisma } from "@/lib/prisma";

export default async function HomePage() {
  const session = await auth();

  const [totalAnalyses, parcellesAgg, avgAgg] = await Promise.all([
    prisma.analysis.count(),
    prisma.analysis.aggregate({ _sum: { totalFeatures: true } }),
    prisma.analysis.aggregate({ _avg: { conformityScore: true } }),
  ]);

  const stats = {
    totalAnalyses,
    totalParcelles: parcellesAgg._sum.totalFeatures ?? 0,
    avgConformity: Number(avgAgg._avg.conformityScore ?? 0),
  };

  return <HomeClient user={session?.user ?? null} stats={stats} />;
}
