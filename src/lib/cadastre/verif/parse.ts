/**
 * Parsing tolérant d'un tableau de bornes recopié ou collé (ou d'un .csv/.txt).
 * Porté depuis cadex-next (`src/lib/verif/parse.ts`), inchangé.
 *
 * Isomorphe : aucune API Node.
 */

import type { Borne, ErreurLigne } from "./types";

export type ResultatParse = {
  bornes: Borne[];
  erreurs: ErreurLigne[];
};

/**
 * Espaces « invisibles » utilisés comme séparateurs de milliers par Excel :
 * insécable (U+00A0), insécable étroite (U+202F), fine (U+2009), tabulaire
 * (U+2007). L'espace ordinaire est volontairement exclu — c'est un séparateur
 * de colonnes, pas un séparateur de milliers.
 */
const ESPACES_MILLIERS = /[\u00A0\u202F\u2009\u2007]/g;

/**
 * Lignes de décoration du tableau, ignorées silencieusement : en-tête de
 * colonnes et pied « Système de coordonnée : RRS04 ».
 */
const LIGNES_IGNOREES = [
  /^\s*(pts?|points?|n[o°]|num([ée]ro)?|borne)\b.*\b(x|est|easting)\b/i,
  /syst[èe]me\s+de\s+coordonn/i,
  /^\s*rrs\s*-?\s*0?4\s*$/i,
];

/**
 * Un identifiant de borne : préfixe littéral optionnel + numéro, avec un
 * éventuel séparateur traînant (« B1 », « b1 », « S1 », « P1 », « 1 », « 1- »).
 */
const ID_BORNE = /^[A-Za-z]{0,2}\s*\d{1,4}\s*[-.)°]?$/;

/**
 * Détermine, **pour tout le bloc**, si la virgule sépare des colonnes ou des
 * décimales.
 *
 * Décider globalement plutôt que ligne par ligne évite qu'un même collage soit
 * interprété de deux façons selon la ligne : dès qu'une tabulation, un `;` ou
 * un `|` est présent quelque part, il est LE séparateur de colonnes, et toute
 * virgule du bloc est décimale.
 */
function virguleEstDecimale(texte: string): boolean {
  return /[\t;|]/.test(texte);
}

/** Convertit un jeton numérique en nombre, ou `null` s'il n'en est pas un. */
function versNombre(jeton: string, virguleDecimale: boolean): number | null {
  let s = jeton.trim().replace(/'/g, "");
  if (!s) return null;
  if (virguleDecimale) s = s.replace(",", ".");
  // Après normalisation, seul un décimal signé est accepté : « 12.34.56 » ou
  // « 12,34,56 » doivent échouer plutôt que d'être silencieusement tronqués.
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Découpe une ligne en jetons, selon le séparateur retenu pour le bloc. */
function decouper(ligne: string, virguleDecimale: boolean): string[] {
  const separateurs = virguleDecimale ? /[\t;|]+|\s{1,}/ : /[\t;|,]+|\s{1,}/;
  return ligne.split(separateurs).filter((t) => t.length > 0);
}

/**
 * Parse un tableau de bornes.
 *
 * Absorbe : tabulations, `;`, `|`, `,`, espaces multiples, décimale `.` ou `,`,
 * séparateurs de milliers, en-tête et pied de tableau, identifiants de borne
 * de forme libre ou absents, lignes vides.
 *
 * Toute ligne non vide et non ignorée qui ne livre pas un couple X/Y exploitable
 * produit une `ErreurLigne` : jamais d'échec silencieux.
 */
export function parseBornes(texte: string): ResultatParse {
  const bornes: Borne[] = [];
  const erreurs: ErreurLigne[] = [];
  if (!texte) return { bornes, erreurs };

  const virguleDecimale = virguleEstDecimale(texte);
  const lignes = texte.replace(/\r\n?/g, "\n").split("\n");

  lignes.forEach((brute, i) => {
    // Les espaces de milliers sont retirés AVANT le découpage : en JavaScript
    // `\s` englobe l'espace insécable, donc « 1 630 987.65 » serait sinon
    // découpé en trois jetons et le nombre perdu.
    const ligne = brute.replace(ESPACES_MILLIERS, "").trim();
    if (!ligne) return;
    if (LIGNES_IGNOREES.some((re) => re.test(ligne))) return;
    // Une ligne sans le moindre chiffre ne peut pas porter de coordonnées :
    // c'est de la décoration (« X  Y », « Est  Nord », un titre). L'ignorer
    // silencieusement évite de noyer l'opérateur sous de fausses erreurs, et
    // ne fait perdre aucune donnée récupérable.
    if (!/\d/.test(ligne)) return;

    const jetons = decouper(ligne, virguleDecimale);
    const rejeter = (motif: string) =>
      erreurs.push({ ligne: i + 1, contenu: brute, motif });

    if (jetons.length < 2) {
      rejeter("il faut au moins un couple X Y sur la ligne");
      return;
    }

    // Trois formes acceptées : « id X Y », « X Y », et « id X Y <extra> ».
    // On repère l'identifiant seulement s'il ne peut pas être un X : un jeton
    // purement numérique en tête est ambigu, on tranche par le nombre de jetons.
    let idBrut: string | null = null;
    let reste = jetons;

    if (jetons.length >= 3 && ID_BORNE.test(jetons[0])) {
      idBrut = jetons[0];
      reste = jetons.slice(1);
    } else if (jetons.length >= 3 && !/^\d/.test(jetons[0])) {
      idBrut = jetons[0];
      reste = jetons.slice(1);
    }

    const x = versNombre(reste[0], virguleDecimale);
    const y = versNombre(reste[1], virguleDecimale);

    if (x === null || y === null) {
      rejeter(
        x === null && y === null
          ? "X et Y illisibles"
          : x === null
            ? "X illisible"
            : "Y illisible",
      );
      return;
    }

    const pt = normaliserId(idBrut, bornes.length + 1);
    bornes.push({ pt, x, y });
  });

  return { bornes, erreurs };
}

/**
 * Normalise un identifiant de borne en `B<n>`. Un identifiant absent ou non
 * numérique est remplacé par la position : la numérotation canonique est de
 * toute façon recalculée par `verifier()` (convention CADEX, départ au Y max).
 */
function normaliserId(idBrut: string | null, position: number): string {
  if (!idBrut) return `B${position}`;
  const m = idBrut.match(/\d{1,4}/);
  return m ? `B${Number(m[0])}` : `B${position}`;
}

/**
 * Sérialise des bornes au format du tableau de coordonnées (TSV, 4 décimales) —
 * utilisé par les tests d'aller-retour et par l'export de la grille.
 */
export function formaterBornes(bornes: Borne[]): string {
  return [
    "Pts\tX (m)\tY (m)",
    ...bornes.map((b) => `${b.pt}\t${b.x.toFixed(4)}\t${b.y.toFixed(4)}`),
    "Système de coordonnée : RRS04",
  ].join("\n");
}
