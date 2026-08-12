import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import JSZip from "jszip";
import { auth } from "@/lib/auth";
import { saveImportUpload } from "@/lib/import/storage";
import { buildShapefileFieldInventory } from "@/lib/import/shapefile-inventory";
import type { ShapefileTarget } from "@/lib/import/field-mapping";

export const runtime = "nodejs";
export const maxDuration = 120;

const VALID_TARGETS: ShapefileTarget[] = ["cad-parcelles", "cad-sections", "sections-limite", "parcelles-home"];

/**
 * POST /api/cadastre/import/inventory — inventaire des colonnes .dbf d'un
 * shapefile AVANT lancement du job (mapping de champs, variante shapefile de
 * `/api/import-jobs/inventory`). Persiste .shp+.dbf ENSEMBLE dans une archive
 * ZIP (un seul `fileKey`, même contrat de colonne que le stockage DXF) —
 * réutilisée telle quelle par `runShapefileImportJob` au démarrage du job.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
    }

    const formData = await req.formData();
    const target = String(formData.get("target") ?? "") as ShapefileTarget;
    if (!VALID_TARGETS.includes(target)) {
      return NextResponse.json(
        { error: "target invalide (cad-parcelles|cad-sections|sections-limite|parcelles-home)." },
        { status: 400 },
      );
    }

    const files = formData.getAll("files") as File[];
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
    const prjFile = files.find((f) => f.name.toLowerCase().endsWith(".prj"));
    if (!shpFile || !dbfFile) {
      return NextResponse.json(
        { error: "Fichier .shp ET .dbf requis (le .dbf porte les attributs à mapper)." },
        { status: 400 },
      );
    }

    const shpBuf = Buffer.from(await shpFile.arrayBuffer());
    const dbfBuf = Buffer.from(await dbfFile.arrayBuffer());

    const zip = new JSZip();
    zip.file(shpFile.name, shpBuf);
    zip.file(dbfFile.name, dbfBuf);
    if (prjFile) zip.file(prjFile.name, Buffer.from(await prjFile.arrayBuffer()));
    const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const fileKey = await saveImportUpload(`${shpFile.name.replace(/\.shp$/i, "")}.zip`, zipBuf);

    const inventory = await buildShapefileFieldInventory(shpBuf, dbfBuf, target);

    return NextResponse.json({ fileKey, fileName: shpFile.name, target, ...inventory });
  } catch (err) {
    console.error("[cadastre/import/inventory] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
