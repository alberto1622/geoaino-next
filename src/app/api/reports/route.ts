import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireSession } from "@/lib/analyses/require-session";

export async function GET() {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;
  const reports = await prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { analysis: { select: { fileName: true, conformityScore: true, totalFeatures: true } } },
  });
  return NextResponse.json(reports);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  const body = await req.json();
  const { analysisId, reportType = "DETAILED" } = body;

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  const title = `Rapport ${reportType === "EXPERT" ? "d'Expert" : reportType === "DETAILED" ? "Détaillé" : "Résumé"} — ${analysis.fileName}`;
  const content = analysis.aiReport || `# ${title}\n\nAnalyse de ${analysis.totalFeatures} parcelles — Score: ${analysis.conformityScore}%`;

  const report = await prisma.report.create({
    data: {
      analysisId,
      userId: session?.user?.id ?? null,
      reportType: reportType as "SUMMARY" | "DETAILED" | "EXPERT" | "CORRECTION",
      title,
      content,
    },
  });

  return NextResponse.json(report);
}
