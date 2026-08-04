import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/analyses/require-session";

type Params = Promise<{ id: string }>;

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const errors = await prisma.topologicalError.findMany({
    where: { analysisId: parseInt(id) },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(errors);
}
