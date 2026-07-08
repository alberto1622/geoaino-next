import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { saveImportUpload } from "@/lib/import/storage";
import { resolveSource } from "@/lib/import/source";
import { createImportJob } from "@/lib/import/jobs";
import { runImportJob } from "@/lib/import/run-job";

// Lecture DXF lourde exécutée après la réponse via `after()` → runtime Node.
export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * POST /api/cadastre/sections/import — construit la table `limite_section` depuis
 * un DXF/DGN/ZIP (couche `limites_sections` + `numero_section`) et contrôle les
 * chevauchements. Retourne `{ jobId }` immédiatement ; le traitement se poursuit
 * en arrière-plan (job `kind:"sections"`), suivi via GET /api/import-jobs/[id].
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await auth();
    const userId = session?.user?.id ?? null;

    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) {
      return NextResponse.json({ error: "Aucun fichier fourni" }, { status: 400 });
    }

    const candidate = files.find((f) => /\.(dxf|dgn|zip)$/i.test(f.name)) ?? files[0];
    const source = await resolveSource(candidate);
    if (!source) {
      return NextResponse.json(
        { error: "Fichiers DXF, DGN ou ZIP les contenant uniquement." },
        { status: 400 },
      );
    }

    const fileKey = await saveImportUpload(source.fileName, source.buffer);
    const job = await createImportJob({
      fileName: source.fileName,
      fileKey,
      sourceType: source.sourceType,
      userId,
      kind: "sections",
    });

    after(() => runImportJob(job.id));

    return NextResponse.json(
      { jobId: job.id, status: job.status, fileName: job.fileName, sourceFichier: job.fileName },
      { status: 202 },
    );
  } catch (err) {
    console.error("[cadastre/sections/import] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
