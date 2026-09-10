import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseBornes } from "@/lib/cadastre/verif/parse";
import type { Borne, ErreurLigne } from "@/lib/cadastre/verif/types";

export const runtime = "nodejs";

/** 2 Mo : un tableau de bornes .csv/.txt pèse ~1 Ko, cette borne est large. */
const TAILLE_MAX = 2 * 1024 * 1024;

type Reponse = {
  bornes: Borne[];
  source: "fichier";
  erreurs: ErreurLigne[];
  avertissement?: string;
};

/**
 * POST /api/cadastre/verif/import — extrait un tableau de bornes d'un fichier
 * `.csv` ou `.txt` (parsing tolérant). geoaino-next ne génère pas de « Plan
 * Morcellement » PDF : la voie PDF (payload / OCR) de cadex-next ne s'applique
 * pas ici — pour reprendre les bornes d'une parcelle connue, utiliser plutôt
 * la recherche par NICAD (`/api/cadastre/verif/referentiel`).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Requête multipart illisible" }, { status: 400 });
  }

  const fichier = form.get("file");
  if (!(fichier instanceof File)) {
    return NextResponse.json(
      { error: "Aucun fichier reçu (champ « file »)." },
      { status: 400 },
    );
  }
  if (fichier.size > TAILLE_MAX) {
    return NextResponse.json(
      { error: `Fichier trop volumineux (maximum ${TAILLE_MAX / 1024 / 1024} Mo).` },
      { status: 400 },
    );
  }

  const nom = fichier.name.toLowerCase();
  if (!nom.endsWith(".csv") && !nom.endsWith(".txt")) {
    return NextResponse.json(
      { error: "Format non pris en charge. Fichiers acceptés : .csv, .txt." },
      { status: 400 },
    );
  }

  try {
    const texte = Buffer.from(await fichier.arrayBuffer()).toString("utf8");
    const { bornes, erreurs } = parseBornes(texte);
    const reponse: Reponse = {
      bornes,
      source: "fichier",
      erreurs,
      avertissement: bornes.length
        ? undefined
        : "Aucune borne n'a pu être lue dans ce fichier. Attendu : une ligne par borne, avec X et Y.",
    };
    return NextResponse.json(reponse);
  } catch (e) {
    console.error("Erreur import verif :", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Erreur : ${message}` }, { status: 500 });
  }
}
