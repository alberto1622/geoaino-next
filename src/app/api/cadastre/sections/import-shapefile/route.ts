import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sectionCandidatesFromShapefile } from "@/lib/cadastre/sections-from-shapefile";
import { buildLimiteSections } from "@/lib/cadastre/build-sections";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/import-shapefile — construit la table
 * `limite_section` directement depuis un shapefile (.shp + .dbf), sans
 * ingestion DXF : les polygones sont déjà valides, seule la jointure commune
 * + le contrôle des chevauchements (`buildLimiteSections`) s'applique.
 * Traitement synchrone (léger comparé au DXF) : pas de job à suivre.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
    }

    const formData = await req.formData();
    const files = formData.getAll("files") as File[];
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    if (!shpFile) {
      return NextResponse.json({ error: "Fichier .shp manquant." }, { status: 400 });
    }
    // Sans .dbf, aucun attribut n'est lu : les sections sont construites mais
    // toutes sans numéro (silencieusement) — mieux vaut rejeter tout de suite.
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
    if (!dbfFile) {
      return NextResponse.json(
        {
          error:
            "Fichier .dbf manquant : sélectionnez le .shp ET son .dbf ensemble (le numéro de section vient du .dbf).",
        },
        { status: 400 },
      );
    }

    const buffers = await Promise.all(
      files
        .filter((f) => /\.(shp|dbf)$/i.test(f.name))
        .map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
    );

    const candidates = await sectionCandidatesFromShapefile(buffers);
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "Aucun polygone de section exploitable dans le shapefile." },
        { status: 400 },
      );
    }

    const sourceFichier = shpFile.name;
    const built = await buildLimiteSections({ sections: candidates }, sourceFichier);

    return NextResponse.json(built, { status: 200 });
  } catch (err) {
    console.error("[cadastre/sections/import-shapefile] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
