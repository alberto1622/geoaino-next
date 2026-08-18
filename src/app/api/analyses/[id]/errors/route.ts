import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/analyses/require-session";

type Params = Promise<{ id: string }>;

export async function GET(req: NextRequest, { params }: { params: Params }) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const errors = await prisma.topologicalError.findMany({
    where: { analysisId: parseInt(id) },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
  });

  // Même principe que geojson/route.ts : cache plus long réservé à la page de
  // consultation seule (`?ro=1`), qui ne peut pas corriger d'erreurs.
  const readOnly = req.nextUrl.searchParams.get("ro") === "1";
  return NextResponse.json(errors, {
    headers: {
      "Cache-Control": readOnly
        ? "private, max-age=300, stale-while-revalidate=3600"
        : "private, max-age=0, must-revalidate",
    },
  });
}
