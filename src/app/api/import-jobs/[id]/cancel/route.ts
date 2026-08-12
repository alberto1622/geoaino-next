import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { cancelImportJob, getImportJob } from "@/lib/import/jobs";

export const runtime = "nodejs";

/**
 * POST /api/import-jobs/[id]/cancel — annule un job pending/running (no-op s'il
 * est déjà terminal). Réservé au propriétaire du job (ou un ADMIN) : sans ce
 * contrôle, n'importe quel utilisateur connecté pourrait annuler le job de
 * n'importe qui d'autre en devinant son id numérique.
 */
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

  const job = await getImportJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job introuvable" }, { status: 404 });
  }
  const isAdmin = (session.user as { role?: string }).role === "ADMIN";
  if (job.userId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Vous ne pouvez annuler que vos propres imports" }, { status: 403 });
  }

  const result = await cancelImportJob(jobId);
  return NextResponse.json(result);
}
