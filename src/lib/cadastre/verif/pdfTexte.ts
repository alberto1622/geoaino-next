/**
 * Extraction de la couche texte d'un plan PDF — module « Vérifier des bornes ».
 * Porté de cadex-next (`src/lib/verif/pdfTexte.ts`), inchangé.
 *
 * **Serveur uniquement** (node:zlib + pdf-lib).
 *
 * Sur un plan numérique, le NICAD / la superficie / la date sont souvent du
 * **vrai texte** ; le tableau de coordonnées peut l'être aussi (plan produit
 * par un logiciel, pas scanné). Récupérer ce texte ne demande qu'à
 * décompresser le flux de contenu de la page et à y lire les chaînes
 * littérales — pdf-lib + zlib suffisent, `pdfjs-dist` (~10 Mo) est réservé à
 * la rastérisation pour l'OCR (`ocr.ts`).
 *
 * Les deux formes de chaînes sont lues (hex `<44414B4152> Tj` et littérale
 * `(DAKAR) Tj`), tous opérateurs `Tj`/`TJ`/`'`/`"` couverts en collectant
 * toute chaîne entre `BT` et `ET`. Encodage WinAnsi (Latin-1).
 */

import zlib from "zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

/** Métadonnées lisibles sur un plan, toutes facultatives. */
export type MetaPlan = {
  nicad?: string;
  /** Superficie **portée sur le plan**, en m² — pas celle recalculée. */
  superficieM2?: number;
  /** Dénominateur d'échelle du plan (500, 1000…). */
  echelle?: number;
  /** Date d'établissement, telle qu'imprimée (jj/mm/aaaa). */
  date?: string;
};

const OUVR = 0x28; // (
const FERM = 0x29; // )
const ANTISLASH = 0x5c;
const CHEVRON_OUVR = 0x3c; // <

/**
 * Concatène et décompresse les flux de contenu de la première page.
 */
async function fluxDeContenu(pdf: Buffer | Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  if (!pages.length) return "";
  const page = pages[0];

  const contents = page.node.get(PDFName.of("Contents"));
  const bruts: unknown[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      bruts.push(page.node.context.lookup(contents.get(i)));
    }
  } else {
    bruts.push(page.node.context.lookup(contents as never));
  }

  let flux = "";
  for (const st of bruts) {
    if (!(st instanceof PDFRawStream)) continue;
    let buf = Buffer.from(st.getContents());
    const filtre = String(st.dict.get(PDFName.of("Filter")) ?? "");
    if (filtre.includes("FlateDecode")) {
      try {
        buf = zlib.inflateSync(buf);
      } catch {
        try {
          buf = zlib.inflateRawSync(buf);
        } catch {
          // Flux illisible (filtre exotique, données corrompues) : on l'ignore
          // plutôt que d'abandonner toute l'extraction.
          continue;
        }
      }
    } else if (filtre && !filtre.includes("FlateDecode")) {
      continue; // filtre non géré (LZW, RunLength…) : rare
    }
    flux += buf.toString("latin1");
  }
  return flux;
}

/**
 * Collecte les chaînes de texte d'un flux de contenu, dans l'ordre de dessin.
 * Seules les chaînes entre `BT` et `ET` sont retenues.
 */
export function chainesDuFlux(flux: string): string[] {
  const out: string[] = [];
  let dansTexte = false;

  for (let i = 0; i < flux.length; i++) {
    const c = flux.charCodeAt(i);

    if (!dansTexte && flux.startsWith("BT", i) && estSepare(flux, i, 2)) {
      dansTexte = true;
      i += 1;
      continue;
    }
    if (dansTexte && flux.startsWith("ET", i) && estSepare(flux, i, 2)) {
      dansTexte = false;
      i += 1;
      continue;
    }
    if (!dansTexte) continue;

    if (c === CHEVRON_OUVR) {
      // « << » ouvre un dictionnaire, pas une chaîne.
      if (flux.charCodeAt(i + 1) === CHEVRON_OUVR) {
        i += 1;
        continue;
      }
      const fin = flux.indexOf(">", i + 1);
      if (fin === -1) break;
      const corps = flux.slice(i + 1, fin).replace(/\s/g, "");
      if (corps.length && /^[0-9A-Fa-f]+$/.test(corps)) {
        const pair = corps.length % 2 ? corps + "0" : corps;
        out.push(Buffer.from(pair, "hex").toString("latin1"));
      }
      i = fin;
      continue;
    }

    if (c === OUVR) {
      let j = i + 1;
      let profondeur = 1;
      let s = "";
      while (j < flux.length && profondeur > 0) {
        const d = flux.charCodeAt(j);
        if (d === ANTISLASH) {
          s += echappement(flux, j);
          j += 2;
          continue;
        }
        if (d === OUVR) profondeur++;
        if (d === FERM) {
          profondeur--;
          if (profondeur === 0) break;
        }
        s += flux[j];
        j++;
      }
      if (s) out.push(s);
      i = j;
    }
  }

  return out;
}

/** Un opérateur doit être délimité par des séparateurs, pas collé à un mot. */
function estSepare(flux: string, i: number, longueur: number): boolean {
  const avant = i === 0 ? 32 : flux.charCodeAt(i - 1);
  const apres = i + longueur >= flux.length ? 32 : flux.charCodeAt(i + longueur);
  const separateur = (c: number) => c <= 32 || c === 0x2f || c === 0x5b || c === 0x5d;
  return separateur(avant) && separateur(apres);
}

/** Résout une séquence d'échappement PDF (spec 7.3.4.2). */
function echappement(flux: string, j: number): string {
  const suivant = flux[j + 1];
  switch (suivant) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "b":
      return "\b";
    case "f":
      return "\f";
    default:
      return suivant ?? "";
  }
}

/** Extrait toutes les chaînes de texte de la première page d'un PDF. */
export async function extraireTextePdf(pdf: Buffer | Uint8Array): Promise<string[]> {
  try {
    return chainesDuFlux(await fluxDeContenu(pdf));
  } catch {
    return [];
  }
}

const RE_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const RE_SUPERFICIE = /^([\d  \s.,]+)\s*m(?:²|2)?$/i;

/**
 * Un NICAD plausible : alphanumérique, au moins 8 caractères, majoritairement
 * des chiffres. Volontairement large — un NICAD erroné ne sera simplement pas
 * trouvé en base.
 */
function estNicad(s: string): boolean {
  const t = s.trim();
  if (t.length < 8 || t.length > 64) return false;
  if (RE_DATE.test(t)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(t)) return false;
  return (t.match(/\d/g)?.length ?? 0) >= 6;
}

function versNombre(brut: string): number | undefined {
  const n = Number(brut.replace(/[  \s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Interprète les chaînes d'un plan : retient la première ayant la bonne forme. */
export function lireMetaPlan(chaines: string[]): MetaPlan {
  const meta: MetaPlan = {};

  for (const brut of chaines) {
    const t = brut.trim();
    if (!t) continue;

    if (!meta.nicad && estNicad(t)) {
      meta.nicad = t;
      continue;
    }
    if (meta.superficieM2 === undefined) {
      const m = t.match(RE_SUPERFICIE);
      if (m) {
        const v = versNombre(m[1]);
        if (v !== undefined && v > 0) {
          meta.superficieM2 = v;
          continue;
        }
      }
    }
    if (!meta.date && RE_DATE.test(t)) {
      meta.date = t;
      continue;
    }
    if (meta.echelle === undefined && /^\d{2,5}$/.test(t)) {
      const v = Number(t);
      if (v >= 100 && v <= 50000) meta.echelle = v;
    }
  }

  return meta;
}
