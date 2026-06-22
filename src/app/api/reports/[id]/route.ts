import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = Promise<{ id: string }>;

export async function DELETE(_req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const reportId = parseInt(id);

  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) return NextResponse.json({ error: "Rapport non trouvé" }, { status: 404 });

  await prisma.report.delete({ where: { id: reportId } });

  return NextResponse.json({ success: true });
}
