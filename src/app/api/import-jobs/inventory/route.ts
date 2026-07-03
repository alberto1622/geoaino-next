import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { saveImportUpload } from "@/lib/import/storage";
import { resolveSource, toDxfBuffer } from "@/lib/import/source";
import { buildLayerInventory, readDxfToFeatureCollection } from "@/lib/import/inventory";

// Lecture DXF (+ conversion DGN) = travail Node (fs, child_process, ogr2ogr).
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/import-jobs/inventory — inventaire des calques d'un fichier CAO
 * (DXF/DGN/ZIP) AVANT lancement de l'import (variante « simple » du mappage).
 *
 * Persiste le fichier source (retourne `fileKey`, réutilisé au démarrage sans
 * re-upload), lit les calques et renvoie pour chacun une classe DGID proposée.
 * L'interface présente le tableau de mappage, puis `POST /api/import-jobs`
 * (corps JSON `{ fileKey, fileName, sourceType, layerMapping }`) lance le job.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await auth(); // réservé aux sessions authentifiées (cohérent avec le démarrage)

    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) {
      return NextResponse.json({ error: "Aucun fichier fourni" }, { status: 400 });
    }

    const candidate = files.find((f) => /\.(dxf|dgn|zip)$/i.test(f.name)) ?? files[0];
    const source = await resolveSource(candidate);
    if (!source) {
      return NextResponse.json(
        { error: "Inventaire réservé aux fichiers DXF, DGN ou ZIP les contenant." },
        { status: 400 },
      );
    }

    const fileKey = await saveImportUpload(source.fileName, source.buffer);
    const dxfBuf = await toDxfBuffer(source.buffer, source.sourceType);
    const fc = await readDxfToFeatureCollection(dxfBuf, source.fileName);
    const layers = buildLayerInventory(fc);

    return NextResponse.json({
      fileKey,
      fileName: source.fileName,
      sourceType: source.sourceType,
      layers,
    });
  } catch (err) {
    console.error("[import-jobs/inventory] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
