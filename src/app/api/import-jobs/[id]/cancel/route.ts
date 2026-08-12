import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { cancelImportJob } from "@/lib/import/jobs";

export const runtime = "nodejs";

/** POST /api/import-jobs/[id]/cancel — annule un job pending/running (no-op s'il est déjà terminal). */
export async function POST(
  _req: NextRequest,
  ctx: RouteContext<"/api/import-jobs/[id]/cancel">,
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  const result = await cancelImportJob(jobId);
  return NextResponse.json(result);
}
