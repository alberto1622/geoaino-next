import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parseBornes } from "@/lib/cadastre/verif/parse";
import { extraireTextePdf, lireMetaPlan } from "@/lib/cadastre/verif/pdfTexte";
import { extraireTexteParPosition } from "@/lib/cadastre/verif/pdfTableauTexte";
import { ocrTableauCoordonnees } from "@/lib/cadastre/verif/ocr";
import { bornesDuReferentiel } from "@/lib/cadastre/verif/referentiel";
import type { Borne, ErreurLigne, SourceVerif } from "@/lib/cadastre/verif/types";

export const runtime = "nodejs";
// La rastérisation OCR d'un plan multipage peut dépasser la limite par défaut.
export const maxDuration = 120;

/** 20 Mo : un plan PDF scanné haute résolution peut être lourd. */
const TAILLE_MAX = 20 * 1024 * 1024;

type Reponse = {
  bornes: Borne[];
  source: SourceVerif;
  meta: { nicad?: string; superficie?: number };
  /** `true` quand les bornes viennent d'un OCR : relecture obligatoire. */
  aRelire: boolean;
  erreurs: ErreurLigne[];
  avertissement?: string;
};

/**
 * POST /api/cadastre/verif/import — extrait un tableau de bornes d'un fichier.
 *
 * `.csv` / `.txt` : parsing tolérant direct.
 * `.pdf` : trois voies, par fiabilité décroissante —
 *   1. couche texte du plan → `parseBornes` (tableau en vrai texte, exact) ;
 *   2. NICAD lu sur le plan → `bornesDuReferentiel` (bornes du référentiel) ;
 *   3. reconnaissance optique du tableau image (`ocr.ts`, à relire).
 * geoaino ne génère pas de « Plan Morcellement » : pas de payload CADEX signé.
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
  const buffer = Buffer.from(await fichier.arrayBuffer());

  try {
    if (nom.endsWith(".pdf")) {
      return NextResponse.json(await importerPdf(buffer));
    }
    if (nom.endsWith(".csv") || nom.endsWith(".txt")) {
      const { bornes, erreurs } = parseBornes(buffer.toString("utf8"));
      const reponse: Reponse = {
        bornes,
        source: "fichier",
        meta: {},
        aRelire: false,
        erreurs,
        avertissement: bornes.length
          ? undefined
          : "Aucune borne n'a pu être lue dans ce fichier. Attendu : une ligne par borne, avec X et Y.",
      };
      return NextResponse.json(reponse);
    }
    return NextResponse.json(
      { error: "Format non pris en charge. Fichiers acceptés : .csv, .txt, .pdf." },
      { status: 400 },
    );
  } catch (e) {
    console.error("Erreur import verif :", e);
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Erreur : ${message}` }, { status: 500 });
  }
}

async function importerPdf(buffer: Buffer): Promise<Reponse> {
  // Métadonnées : lues sans OCR, utiles dans toutes les voies.
  const chaines = await extraireTextePdf(buffer);
  const meta = lireMetaPlan(chaines);
  const metaSortie = { nicad: meta.nicad, superficie: meta.superficieM2 };

  // Voie 1 — le tableau est du vrai texte dans le PDF. Reconstruction PAR
  // POSITION (pdfjs-dist, regroupe les fragments en lignes de lecture) :
  // la plupart des générateurs PDF dessinent chaque cellule séparément
  // (« B1 », « 500000.0000 », « 1600100.0000 » en trois appels), et leur
  // ORDRE DE DESSIN ne correspond pas forcément à l'ordre de lecture visuel
  // — sur des plans de sources variées, ça produisait des bornes manquantes,
  // en trop ou mal recomposées (cf. pdfTableauTexte.ts). Repli sur l'ordre
  // de dessin (pdf-lib) seulement si pdfjs-dist est indisponible.
  const texteParPosition = await extraireTexteParPosition(buffer);
  const texteVoie1 = texteParPosition ?? nettoyerChainesPdf(chaines);
  const parTexte = parseBornes(texteVoie1);
  if (parTexte.bornes.length >= 3) {
    return {
      bornes: parTexte.bornes,
      source: "pdf-texte",
      meta: metaSortie,
      aRelire: false,
      erreurs: parTexte.erreurs,
      avertissement:
        "Bornes lues dans la couche texte du plan. Vérifiez qu'il s'agit bien du tableau de coordonnées et non d'autres nombres du document.",
    };
  }

  // Voie 2 — NICAD lu sur le plan, bornes reprises du référentiel.
  if (meta.nicad) {
    const ref = await bornesDuReferentiel(meta.nicad);
    if (ref && ref.bornes.length >= 3) {
      return {
        bornes: ref.bornes,
        source: "pdf-referentiel",
        meta: {
          nicad: meta.nicad,
          // Superficie IMPRIMÉE sur le plan (pas recalculée) : c'est ce qui
          // permet de confronter le papier au référentiel via ECART_SUPERFICIE.
          superficie: meta.superficieM2 ?? ref.superficieDeclaree,
        },
        aRelire: false,
        erreurs: [],
        avertissement:
          "Bornes reconstituées depuis le référentiel à partir du NICAD lu sur le plan, non relevées sur le tableau imprimé.",
      };
    }
  }

  // Voie 3 — reconnaissance optique du tableau image.
  const ocr = await ocrTableauCoordonnees(buffer);
  if (!ocr.bornes.length) {
    return {
      bornes: [],
      source: "pdf-ocr",
      meta: { nicad: ocr.meta.nicad ?? meta.nicad, superficie: ocr.meta.superficie ?? meta.superficieM2 },
      aRelire: false,
      erreurs: ocr.erreurs,
      avertissement:
        ocr.motifEchec ??
        "Le tableau de coordonnées de ce plan n'a pas pu être lu. Utilisez la saisie ou le collage.",
    };
  }

  return {
    bornes: ocr.bornes,
    source: "pdf-ocr",
    meta: { nicad: ocr.meta.nicad ?? meta.nicad, superficie: ocr.meta.superficie ?? meta.superficieM2 },
    aRelire: true,
    erreurs: ocr.erreurs,
    avertissement:
      "Bornes obtenues par reconnaissance optique : relisez chaque coordonnée avant d'enregistrer. Les confusions 0/O, 1/7 et 5/6 sur la 4e décimale sont fréquentes.",
  };
}

/**
 * Prépare les chaînes d'une couche texte PDF pour `parseBornes` : une chaîne
 * par ligne, et on éclate sur les identifiants de borne (« B1 240… 1630… »
 * peut arriver en une seule chaîne).
 */
function nettoyerChainesPdf(chaines: string[]): string {
  return chaines
    .join("\n")
    .replace(/\r/g, "")
    .replace(/\bB\s*(\d)/g, "\nB$1")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
