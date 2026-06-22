import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = Promise<{ id: string }>;

export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const { id } = await params;
  const errors = await prisma.topologicalError.findMany({
    where: { analysisId: parseInt(id) },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(errors);
}
