import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getImportJob } from "@/lib/import/jobs";

export const runtime = "nodejs";

/**
 * GET /api/import-jobs/[id] — état d'avancement d'un job d'import (sondage côté
 * interface : `status`, `phase`, `progress`, compteurs, `report`).
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/import-jobs/[id]">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  const job = await getImportJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job introuvable" }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    fileName: job.fileName,
    sourceType: job.sourceType,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    totalBuilt: job.totalBuilt,
    analysisId: job.analysisId,
    report: job.report,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
}
