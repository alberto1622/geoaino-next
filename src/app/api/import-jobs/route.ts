import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { saveImportUpload } from "@/lib/import/storage";
import { resolveSource, type ResolvedSource } from "@/lib/import/source";
import { createImportJob, listImportJobs, type SourceType } from "@/lib/import/jobs";
import { runImportJob } from "@/lib/import/run-job";
import { CADASTRAL_CLASSES, type LayerMapping } from "@/lib/cadastral-filter";

// Lecture DXF + polygonisation = travail lourd exécuté APRÈS la réponse via
// `after()` : on force le runtime Node (fs, child_process, ogr2ogr) et on relève
// la durée max autorisée pour la tâche d'arrière-plan.
export const runtime = "nodejs";
export const maxDuration = 600;

const ALLOWED_MAPPING_VALUES = new Set<string>([...CADASTRAL_CLASSES, "ignore"]);

/** Valide/assainit un mappage calque → classe reçu du client. */
function sanitizeLayerMapping(input: unknown): LayerMapping | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: LayerMapping = {};
  for (const [layer, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && ALLOWED_MAPPING_VALUES.has(value)) {
      out[layer] = value as LayerMapping[string];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Démarre le job depuis une source résolue + un mappage optionnel, puis planifie
 * le traitement en arrière-plan (`after()`).
 */
async function startJob(
  source: ResolvedSource,
  userId: string | null,
  layerMapping: LayerMapping | undefined,
  fileKey: string,
): Promise<NextResponse> {
  const job = await createImportJob({
    fileName: source.fileName,
    fileKey,
    sourceType: source.sourceType,
    userId,
    layerMapping,
  });

  // Exécution après la réponse (serveur Node persistant) : la requête ne bloque
  // pas le navigateur, l'interface sonde ensuite GET /api/import-jobs/[id].
  after(() => runImportJob(job.id));

  return NextResponse.json(
    { jobId: job.id, status: job.status, fileName: job.fileName, sourceType: job.sourceType },
    { status: 202 },
  );
}

/**
 * POST /api/import-jobs — démarre un import en lot (DXF/DGN/ZIP). Retourne
 * immédiatement `{ jobId }` ; le traitement (lecture, polygonisation, NICAD,
 * persistance) se poursuit en arrière-plan.
 *
 * Deux voies :
 *  - JSON `{ fileKey, fileName, sourceType, layerMapping? }` : le fichier a déjà
 *    été téléversé par `POST /api/import-jobs/inventory` (variante « simple » :
 *    mappage des calques validé avant lancement) — aucun re-upload.
 *  - multipart `files` : voie directe historique (sans mappage).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await auth();
    const userId = session?.user?.id ?? null;

    const contentType = req.headers.get("content-type") ?? "";

    // Voie JSON : fichier déjà téléversé (inventaire) + mappage validé.
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        fileKey?: string;
        fileName?: string;
        sourceType?: string;
        layerMapping?: unknown;
      };
      if (!body.fileKey || !body.fileName || (body.sourceType !== "DXF" && body.sourceType !== "DGN")) {
        return NextResponse.json(
          { error: "Requête invalide : fileKey, fileName et sourceType (DXF|DGN) requis." },
          { status: 400 },
        );
      }
      const source: ResolvedSource = {
        buffer: Buffer.alloc(0), // non utilisé (fichier déjà persisté sous fileKey)
        fileName: body.fileName,
        sourceType: body.sourceType as SourceType,
      };
      return startJob(source, userId, sanitizeLayerMapping(body.layerMapping), body.fileKey);
    }

    // Voie multipart : upload direct (sans mappage).
    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) {
      return NextResponse.json({ error: "Aucun fichier fourni" }, { status: 400 });
    }

    const candidate = files.find((f) => /\.(dxf|dgn|zip)$/i.test(f.name)) ?? files[0];
    const source = await resolveSource(candidate);
    if (!source) {
      return NextResponse.json(
        { error: "Import en lot réservé aux fichiers DXF, DGN ou ZIP les contenant." },
        { status: 400 },
      );
    }

    const fileKey = await saveImportUpload(source.fileName, source.buffer);
    return startJob(source, userId, undefined, fileKey);
  } catch (err) {
    console.error("[import-jobs] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** GET /api/import-jobs — liste les jobs récents. */
export async function GET(): Promise<NextResponse> {
  const jobs = await listImportJobs(20);
  return NextResponse.json({ jobs });
}
