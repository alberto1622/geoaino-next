import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import ReportsClient from "@/components/ReportsClient";

export default async function ReportsPage() {
  const session = await auth();

  const reports = await prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      analysis: {
        select: { fileName: true, conformityScore: true, totalFeatures: true },
      },
    },
  });

  const serialized = reports.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    analysis: r.analysis
      ? { ...r.analysis, conformityScore: Number(r.analysis.conformityScore) }
      : null,
  }));

  return <ReportsClient user={session?.user ?? null} reports={serialized} />;
}
