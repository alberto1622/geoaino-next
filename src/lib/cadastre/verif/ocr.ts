/* eslint-disable @typescript-eslint/no-explicit-any -- ce module pilote des
   paquets chargés dynamiquement (pdfjs-dist, tesseract.js, @napi-rs/canvas)
   dont les types ne peuvent pas être connus statiquement. */
/**
 * Lecture optique du tableau de coordonnées — dernier recours, pour un plan
 * de morcellement **numérisé ou étranger** dont le tableau est une image.
 * Porté de cadex-next (`src/lib/verif/ocr.ts`).
 *
 * **Serveur uniquement.**
 *
 * `pdfjs-dist` (rastérisation), `tesseract.js` (reconnaissance) et
 * `@napi-rs/canvas` (surface de rendu) sont volumineux et ne servent qu'ici.
 * Ils sont chargés **dynamiquement**, et leur absence (paquet manquant,
 * binaire natif cassé) n'est pas une erreur : le module renvoie alors un
 * motif d'échec explicite et l'opérateur bascule sur la saisie ou le collage.
 *
 * Le résultat n'est **jamais** exploitable tel quel : l'appelant marque les
 * bornes « à relire » et bloque l'enregistrement tant que l'opérateur n'a pas
 * confirmé. Sur des coordonnées à 4 décimales, les confusions 0/O, 1/7 et 5/6
 * sont trop fréquentes pour accorder la moindre confiance automatique.
 */

import { parseBornes } from "./parse";
import { extraireTextePdf, lireMetaPlan } from "./pdfTexte";
import type { Borne, ErreurLigne } from "./types";

export type ResultatOcr = {
  bornes: Borne[];
  meta: { nicad?: string; superficie?: number };
  erreurs: ErreurLigne[];
  /** Renseigné quand aucune borne n'a pu être produite. */
  motifEchec?: string;
};

/** Résolution de rastérisation : au-delà, l'OCR ne gagne plus en fiabilité. */
const ECHELLE_RASTER = 4;

/** Caractères possibles dans le tableau : chiffres, point, et la lettre B. */
const LISTE_BLANCHE = "0123456789.B";

/**
 * Charge un paquet optionnel. Le spécificateur passe par une **variable** :
 * c'est délibéré, un `import()` littéral serait résolu statiquement par le
 * bundler et l'absence du paquet deviendrait une erreur de compilation, alors
 * que tout ce module est bâti pour survivre à cette absence. Prix à payer :
 * un avertissement « dépendance critique » du bundler, sans effet au runtime
 * Node (ces routes déclarent `runtime = "nodejs"`).
 */
async function chargerOptionnel(specificateur: string): Promise<any | null> {
  try {
    return await import(/* webpackIgnore: true */ /* @vite-ignore */ specificateur);
  } catch {
    return null;
  }
}

const INDISPONIBLE =
  "Le tableau de coordonnées de ce plan est une image, et la reconnaissance optique n'est pas disponible sur ce serveur. Saisissez ou collez le tableau.";

/**
 * Charge `tesseract.js`, en repliant sur `default` si besoin. `recognize`/
 * `detect` n'y sont exposés QUE sur `default` (l'espace de noms ESM porte
 * `createWorker`/`createScheduler`, mais pas ces deux raccourcis) — à la
 * différence de pdfjs-dist, qui expose tout directement.
 */
async function chargerTesseract(): Promise<any | null> {
  const mod = await chargerOptionnel("tesseract.js");
  return mod?.default ?? mod;
}

/**
 * Cœur de la reconnaissance : lance tesseract sur une image RASTER déjà
 * prête (PNG/JPEG…), liste blanche restreinte aux caractères d'un tableau de
 * bornes. Isolé pour être partagé entre la voie PDF (rendu de page,
 * `ocrTableauCoordonnees`) et la voie image directe (`ocrImageCoordonnees`).
 *
 * Lit GEOAINO_TESSERACT_LANG_PATH à **l'appel** (pas au chargement du module),
 * de sorte qu'un test ou une tâche peut basculer le chemin de langue entre
 * appels. En production, cette variable est fixée par le process Electron avant
 * le démarrage (cf. desktop/src/runtime-env.ts), et son absence signifie
 * « récupérer les données sur le CDN tesseract par défaut ».
 */
async function reconnaitreImage(
  tesseract: any,
  image: Buffer,
): Promise<string> {
  const cheminLangueOcr = process.env.GEOAINO_TESSERACT_LANG_PATH;
  const { data } = await tesseract.recognize(image, "eng", {
    tessedit_char_whitelist: LISTE_BLANCHE,
    ...(cheminLangueOcr ? { langPath: cheminLangueOcr, cachePath: cheminLangueOcr } : {}),
  });
  return nettoyerTexteOcr(data?.text ?? "");
}

/** Extrait le tableau de coordonnées d'un plan PDF dont le tableau est une image. */
export async function ocrTableauCoordonnees(pdf: Buffer): Promise<ResultatOcr> {
  // Les métadonnées se lisent sans OCR et restent utiles si la reconnaissance
  // échoue : elles pré-remplissent NICAD et superficie.
  const brut = lireMetaPlan(await extraireTextePdf(pdf));
  const meta = { nicad: brut.nicad, superficie: brut.superficieM2 };

  const pdfjs = await chargerOptionnel("pdfjs-dist/legacy/build/pdf.mjs");
  const tesseract = await chargerTesseract();
  if (!pdfjs || !tesseract) {
    return { bornes: [], meta, erreurs: [], motifEchec: INDISPONIBLE };
  }

  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      useSystemFonts: true,
      // Sous Node, pdfjs-dist met `disableFontFace` à `true` par défaut : au
      // lieu de dessiner le texte par police native (`ctx.font`/`fillText`),
      // il reconstruit chaque glyphe en chemin vectoriel manuel
      // (`getPathGenerator` + `ctx.fill(path)`) — repli hérité des anciennes
      // limites de `node-canvas` sur les polices embarquées. Ce chemin n'est
      // pas fiable avec @napi-rs/canvas : dès qu'une page porte du texte
      // vectoriel (systématique sur un plan réel, même quand le tableau de
      // bornes lui-même est une image) le rendu lève une erreur native du
      // binding (« Value is none of these types `String`, `Path`, » — objet
      // de chemin renvoyé par `getPathGenerator` non reconnu par
      // `ctx.fill()`), reproduit hors serveur sur un PDF avec texte + image.
      // @napi-rs/canvas gère correctement le rendu par police native : on
      // force cette voie plutôt que le repli en chemins vectoriels.
      disableFontFace: false,
    }).promise;
  } catch (e: any) {
    return {
      bornes: [],
      meta,
      erreurs: [],
      motifEchec: `Ce fichier PDF n'a pas pu être ouvert (${e?.message ?? e}).`,
    };
  }

  try {
    // Toutes les pages : un plan de morcellement porte parfois son tableau
    // sur une seconde feuille.
    const morceaux: string[] = [];
    const nbPages = Math.min(doc.numPages ?? 1, 5);
    for (let p = 1; p <= nbPages; p++) {
      const page = await doc.getPage(p);
      const png = await rasteriser(page);
      morceaux.push(await reconnaitreImage(tesseract, png));
    }
    const { bornes, erreurs } = parseBornes(morceaux.join("\n"));
    return {
      bornes,
      meta,
      erreurs,
      motifEchec: bornes.length
        ? undefined
        : "La reconnaissance optique n'a extrait aucune coordonnée exploitable de ce plan.",
    };
  } catch (e: any) {
    return {
      bornes: [],
      meta,
      erreurs: [],
      motifEchec: `La reconnaissance optique a échoué (${e?.message ?? e}).`,
    };
  } finally {
    await doc.destroy?.();
  }
}

/**
 * Extrait le tableau de bornes d'une IMAGE directe (photo/capture d'écran
 * recadrée par l'opérateur sur la zone Pts/X/Y — cf. `PlanVerifClient.tsx`,
 * onglet « Photo »). Contrairement à `ocrTableauCoordonnees`, aucune étape de
 * rendu : une image n'a pas besoin d'être rastérisée depuis un PDF, elle est
 * déjà une matrice de pixels — envoyée telle quelle à tesseract. Pas de
 * métadonnées (NICAD/superficie) : le recadrage exclut par construction le
 * reste du document.
 */
export async function ocrImageCoordonnees(image: Buffer): Promise<ResultatOcr> {
  const tesseract = await chargerTesseract();
  if (!tesseract) {
    return {
      bornes: [],
      meta: {},
      erreurs: [],
      motifEchec:
        "La reconnaissance optique n'est pas disponible sur ce serveur. Saisissez ou collez le tableau.",
    };
  }

  try {
    const texte = await reconnaitreImage(tesseract, image);
    const { bornes, erreurs } = parseBornes(texte);
    return {
      bornes,
      meta: {},
      erreurs,
      motifEchec: bornes.length
        ? undefined
        : "La reconnaissance optique n'a extrait aucune coordonnée exploitable de cette image. Recadrez plus précisément sur le tableau Pts/X/Y, ou saisissez les bornes.",
    };
  } catch (e: any) {
    return {
      bornes: [],
      meta: {},
      erreurs: [],
      motifEchec: `La reconnaissance optique a échoué (${e?.message ?? e}).`,
    };
  }
}

/** Rastérise une page en PNG, via @napi-rs/canvas. */
async function rasteriser(page: any): Promise<Buffer> {
  const canvasMod = await chargerOptionnel("@napi-rs/canvas");
  if (!canvasMod?.createCanvas) {
    throw new Error("@napi-rs/canvas indisponible");
  }
  const viewport = page.getViewport({ scale: ECHELLE_RASTER });
  const canvas = canvasMod.createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx as any, viewport }).promise;
  return canvas.toBuffer("image/png");
}

/**
 * Remet le texte OCR en forme de tableau : l'OCR rend souvent
 * « B1 240123.4567 1630987.6543 » sur une seule ligne. On redécoupe sur les
 * identifiants de borne, seul repère fiable.
 */
function nettoyerTexteOcr(texte: string): string {
  return texte
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\bB\s*(\d)/g, "\nB$1")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}
