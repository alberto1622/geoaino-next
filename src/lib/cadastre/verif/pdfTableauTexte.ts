/**
 * Reconstruction du tableau de bornes depuis la couche texte d'un plan PDF,
 * **par position** — voie 1 de l'import (`pdf-texte`), § import/route.ts.
 *
 * `pdfTexte.ts` (pdf-lib + zlib) collecte les chaînes de texte d'une page
 * dans leur **ordre de dessin** dans le flux de contenu, sans savoir où
 * chacune est positionnée. Ça suffit pour trouver le NICAD ou la superficie
 * (une seule chaîne à reconnaître par sa forme, l'ordre n'a pas d'importance)
 * mais pas pour reconstruire un TABLEAU : la plupart des générateurs PDF
 * dessinent chaque cellule comme une chaîne séparée (« B1 », « 500000.0000 »,
 * « 1600100.0000 » en trois appels), et l'ordre de dessin d'un logiciel donné
 * ne correspond pas forcément à l'ordre de lecture visuel (colonne par
 * colonne, cartouche entremêlé, etc.). Sur des plans de sources variées
 * (géomètres privés, autres bureaux — cf. § import/route.ts), ce décalage
 * produit des bornes manquantes, en trop, ou mal recomposées : signalé par
 * l'utilisateur après avoir chargé un plan dont le tableau est du texte
 * (pas une image) mais pas dessiné ligne par ligne.
 *
 * Solution : `pdfjs-dist` (déjà une dépendance, pour l'OCR) sait, via
 * `page.getTextContent()`, la position (x, y) exacte de chaque fragment de
 * texte après application de la matrice de transformation PDF complète —
 * un travail qu'un parseur de flux de contenu écrit à la main (`pdfTexte.ts`)
 * ne fait pas. On regroupe les fragments en LIGNES par proximité verticale,
 * on trie chaque ligne par position horizontale, et on ne recompose ainsi
 * qu'un texte dans l'ordre de LECTURE — plus fiable que l'ordre de dessin.
 *
 * **Serveur uniquement**, dépendance optionnelle (comme `ocr.ts`) : renvoie
 * `null` si `pdfjs-dist` n'est pas installé, plutôt que d'échouer.
 */

/** Tolérance de regroupement en ligne (unités PDF, ~points) — deux fragments
 *  dont la ligne de base diffère de moins de ce seuil sont la même ligne. */
const TOLERANCE_LIGNE_PT = 3;

/**
 * Charge un paquet optionnel — même motif que `ocr.ts` (spécificateur en
 * variable pour ne pas être résolu statiquement par le bundler).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function chargerOptionnel(specificateur: string): Promise<any | null> {
  try {
    return await import(/* webpackIgnore: true */ /* @vite-ignore */ specificateur);
  } catch {
    return null;
  }
}

/**
 * Reconstruit, page par page, le texte du document dans l'ordre de LECTURE
 * (ligne par ligne, gauche à droite au sein d'une ligne) — pas l'ordre de
 * dessin. `null` si `pdfjs-dist` est indisponible ou si le document est
 * illisible ; chaîne vide si lisible mais sans aucun texte (page entièrement
 * en image, par ex.).
 */
export async function extraireTexteParPosition(pdf: Buffer): Promise<string | null> {
  const pdfjs = await chargerOptionnel("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs) return null;

  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
  } catch {
    return null;
  }

  try {
    const lignesParPage: string[] = [];
    const nbPages = Math.min(doc.numPages ?? 1, 5);
    for (let p = 1; p <= nbPages; p++) {
      const page = await doc.getPage(p);
      const contenu = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fragments = (contenu.items as any[])
        .filter((it) => typeof it.str === "string" && it.str.trim().length > 0)
        .map((it) => ({
          texte: it.str as string,
          x: it.transform?.[4] as number,
          y: it.transform?.[5] as number,
        }))
        .filter((f) => Number.isFinite(f.x) && Number.isFinite(f.y));

      lignesParPage.push(regrouperEnLignes(fragments));
    }
    return lignesParPage.filter(Boolean).join("\n");
  } catch {
    return null;
  } finally {
    await doc.destroy?.();
  }
}

/**
 * Regroupe des fragments positionnés en lignes de lecture : tri par Y
 * décroissant (le haut de la page en premier — l'axe Y d'un PDF pointe vers
 * le haut), fragments consécutifs à moins de `TOLERANCE_LIGNE_PT` dans la
 * même ligne, puis tri par X croissant au sein de chaque ligne.
 */
function regrouperEnLignes(fragments: { texte: string; x: number; y: number }[]): string {
  if (!fragments.length) return "";
  const tries = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x);

  const lignes: { y: number; items: typeof tries }[] = [];
  for (const f of tries) {
    const ligne = lignes.find((l) => Math.abs(l.y - f.y) <= TOLERANCE_LIGNE_PT);
    if (ligne) {
      ligne.items.push(f);
      // Ligne de base = moyenne courante, pour absorber une dérive légère
      // (fragments d'une même rangée pas tous exactement à la même hauteur).
      ligne.y = (ligne.y * (ligne.items.length - 1) + f.y) / ligne.items.length;
    } else {
      lignes.push({ y: f.y, items: [f] });
    }
  }

  return lignes
    .map((l) =>
      l.items
        .sort((a, b) => a.x - b.x)
        .map((f) => f.texte.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n");
}
