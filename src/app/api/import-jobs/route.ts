import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import JSZip from "jszip";
import { auth } from "@/lib/auth";
import { saveImportUpload } from "@/lib/import/storage";
import { resolveSource, type ResolvedSource } from "@/lib/import/source";
import { createImportJob, listImportJobs, type SourceType, type JobKind } from "@/lib/import/jobs";
import { runImportJob } from "@/lib/import/run-job";
import { CADASTRAL_CLASSES, type LayerMapping } from "@/lib/cadastral-filter";
import { targetFieldsFor, type ShapefileTarget } from "@/lib/import/field-mapping";

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

/** Cible shapefile (`ShapefileTarget`) correspondant au `kind` de job reçu du client. */
function shapefileTargetForKind(kind: string | undefined): ShapefileTarget {
  if (kind === "cad-sections") return "cad-sections";
  if (kind === "sections") return "sections-limite";
  return "cad-parcelles";
}

/** Valide/assainit un mappage champ cible → colonne .dbf reçu du client (job shapefile). */
function sanitizeFieldMapping(input: unknown, kind: string | undefined): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const allowedKeys = new Set(targetFieldsFor(shapefileTargetForKind(kind)).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (allowedKeys.has(key) && typeof value === "string" && value.trim()) {
      out[key] = value;
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
  layerMapping: LayerMapping | Record<string, string> | undefined,
  fileKey: string,
  kind?: JobKind,
): Promise<NextResponse> {
  const job = await createImportJob({
    fileName: source.fileName,
    fileKey,
    sourceType: source.sourceType,
    userId,
    layerMapping,
    kind,
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
        kind?: string;
        layerMapping?: unknown;
      };
      if (!body.fileKey || !body.fileName) {
        return NextResponse.json({ error: "Requête invalide : fileKey et fileName requis." }, { status: 400 });
      }

      if (body.sourceType === "SHP") {
        if (!userId) {
          return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
        }
        if (!body.kind || !["cad-parcelles", "cad-sections", "sections"].includes(body.kind)) {
          return NextResponse.json(
            { error: "kind requis pour un job shapefile (cad-parcelles|cad-sections|sections)." },
            { status: 400 },
          );
        }
        const source: ResolvedSource = {
          buffer: Buffer.alloc(0), // non utilisé (fichier déjà persisté sous fileKey)
          fileName: body.fileName,
          sourceType: "SHP" as SourceType,
        };
        return startJob(
          source,
          userId,
          sanitizeFieldMapping(body.layerMapping, body.kind),
          body.fileKey,
          body.kind as JobKind,
        );
      }

      if (body.sourceType !== "DXF" && body.sourceType !== "DGN") {
        return NextResponse.json(
          { error: "Requête invalide : sourceType doit être DXF, DGN ou SHP." },
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

    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    if (shpFile) {
      const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
      if (!dbfFile) {
        return NextResponse.json(
          { error: "Sélectionnez le .shp ET son .dbf ensemble." },
          { status: 400 },
        );
      }
      const prjFile = files.find((f) => f.name.toLowerCase().endsWith(".prj"));

      const zip = new JSZip();
      zip.file(shpFile.name, Buffer.from(await shpFile.arrayBuffer()));
      zip.file(dbfFile.name, Buffer.from(await dbfFile.arrayBuffer()));
      if (prjFile) zip.file(prjFile.name, Buffer.from(await prjFile.arrayBuffer()));
      const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
      const fileKey = await saveImportUpload(`${shpFile.name.replace(/\.shp$/i, "")}.zip`, zipBuf);

      const source: ResolvedSource = {
        buffer: Buffer.alloc(0), // non utilisé (fichier déjà persisté sous fileKey)
        fileName: shpFile.name,
        sourceType: "SHP" as SourceType,
      };
      return startJob(source, userId, undefined, fileKey, "parcelles");
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
