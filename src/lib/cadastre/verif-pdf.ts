/**
 * Procès-verbal de vérification (PDF) — module « Vérifier des bornes ».
 *
 * **Client uniquement** (jsPDF, chargé dynamiquement — même convention que
 * `src/lib/exportPdf.ts`). cadex-next génère son PV côté serveur (pdf-lib +
 * @napi-rs/canvas) et le stocke sur disque ; geoaino-next n'a pas cette
 * infrastructure et sa convention PDF est le rendu navigateur à la demande.
 *
 * Le PV est construit à partir du **rapport renvoyé par le serveur**
 * (`POST /api/cadastre/verif`), jamais d'un recalcul client : c'est toujours
 * le résultat qui fait foi qui est imprimé.
 *
 * jsPDF (polices standard) encode en WinAnsi : on nettoie les caractères hors
 * répertoire (`→`, `∈`, `≤`…) avant tout `doc.text`.
 */

import type { jsPDF as JsPDFType } from "jspdf";
import { VERDICT_LIBELLE } from "./verif/core";
import type { CrsSource, SourceVerif, VerifRapport } from "./verif/types";

export type EnTetePv = {
  operateur: string;
  nicad?: string | null;
  crsSource: CrsSource;
  source: SourceVerif;
  date: Date;
};

const LIBELLE_SOURCE: Record<SourceVerif, string> = {
  saisie: "Saisie manuelle / collage",
  fichier: "Import d'un fichier CSV / TXT",
  referentiel: "Bornes reprises du referentiel (recherche par NICAD)",
  "pdf-texte": "Plan PDF - tableau lu dans la couche texte",
  "pdf-referentiel": "Plan PDF - NICAD lu, bornes reprises du referentiel",
  "pdf-ocr": "Plan PDF - reconnaissance optique, relue par l'operateur",
  "image-ocr": "Photo recadree - reconnaissance optique, relue par l'operateur",
};

type RGB = [number, number, number];
const COULEUR_VERDICT: Record<VerifRapport["verdict"], RGB> = {
  CONFORME: [33, 140, 74],
  CONFORME_AVEC_RESERVE: [183, 117, 15],
  NON_CONFORME: [183, 41, 41],
};

const LIBELLE_SEVERITE: Record<"erreur" | "avertissement" | "info", string> = {
  erreur: "Erreurs",
  avertissement: "Avertissements",
  info: "Informations",
};

/** Remplace les caractères hors WinAnsi que nos messages peuvent contenir. */
function nettoyer(s: string): string {
  return s
    .replace(/[→⟶]/g, " vers ")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/∈/g, " dans ")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/×/g, "x");
}

const dateFr = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ` +
  `a ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 16;
const CONTENT_W = PAGE_W - 2 * MARGIN;

/** Curseur d'écriture : suit la position verticale et pagine au besoin. */
class Feuille {
  y = MARGIN;
  constructor(public doc: JsPDFType) {}

  place(h: number) {
    if (this.y + h > PAGE_H - MARGIN) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  texte(
    s: string,
    o: { taille?: number; gras?: boolean; italique?: boolean; couleur?: RGB; x?: number } = {},
  ) {
    const taille = o.taille ?? 9.5;
    this.place(taille * 0.5 + 2);
    this.doc.setFontSize(taille);
    this.doc.setFont("helvetica", o.gras ? "bold" : o.italique ? "italic" : "normal");
    const c = o.couleur ?? [15, 23, 42];
    this.doc.setTextColor(c[0], c[1], c[2]);
    const lignes = this.doc.splitTextToSize(nettoyer(s), CONTENT_W) as string[];
    this.y += taille * 0.42 + 1.6;
    this.doc.text(lignes, o.x ?? MARGIN, this.y);
    this.y += (lignes.length - 1) * taille * 0.42;
  }

  titreSection(s: string) {
    this.place(12);
    this.y += 6;
    this.texte(s, { taille: 11, gras: true });
    this.y += 1.5;
    this.doc.setDrawColor(191, 191, 191);
    this.doc.setLineWidth(0.2);
    this.doc.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
    this.y += 1;
  }

  espace(h = 3) {
    this.y += h;
  }

  /** Tableau à largeurs de colonnes fixes (mm), report d'en-tête à la pagination. */
  tableau(entetes: string[], lignes: string[][], largeurs: number[]) {
    const hl = 5;
    const taille = 8;
    const total = largeurs.reduce((a, b) => a + b, 0);

    const enTete = () => {
      this.place(hl * 2);
      this.doc.setFontSize(taille);
      this.doc.setFont("helvetica", "bold");
      this.doc.setTextColor(15, 23, 42);
      let x = MARGIN;
      entetes.forEach((t, i) => {
        this.doc.text(nettoyer(t), x + 1, this.y + hl - 1.5);
        x += largeurs[i];
      });
      this.y += hl;
      this.doc.setDrawColor(191, 191, 191);
      this.doc.setLineWidth(0.2);
      this.doc.line(MARGIN, this.y, MARGIN + total, this.y);
    };

    enTete();
    for (const ligne of lignes) {
      if (this.y + hl > PAGE_H - MARGIN) {
        this.doc.addPage();
        this.y = MARGIN;
        enTete();
      }
      this.doc.setFont("helvetica", "normal");
      this.doc.setTextColor(15, 23, 42);
      let x = MARGIN;
      ligne.forEach((t, i) => {
        this.doc.text(nettoyer(t), x + 1, this.y + hl - 1.5);
        x += largeurs[i];
      });
      this.y += hl;
    }
    this.espace(2);
  }
}

/**
 * Croquis de la parcelle : contour rempli + bordé, bornes numérotées,
 * longueurs portées au milieu des côtés — tracé vectoriel jsPDF (pas de
 * canvas). Repère projeté, sans reprojection.
 */
function dessinerCroquis(f: Feuille, bornes: VerifRapport["bornes"], boiteMm = 110) {
  const doc = f.doc;
  const xs = bornes.map((b) => b.x);
  const ys = bornes.map((b) => b.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cote = Math.max(maxX - minX, maxY - minY) * 1.22 || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  f.place(boiteMm + 8);
  const ox = MARGIN + (CONTENT_W - boiteMm) / 2;
  const oy = f.y;

  // Coordonnée projetée -> mm dans la boîte (Y inversé : nord en haut).
  const px = (x: number) => ox + ((x - (cx - cote / 2)) / cote) * boiteMm;
  const py = (y: number) => oy + boiteMm - ((y - (cy - cote / 2)) / cote) * boiteMm;

  const pts = bornes.map((b) => [px(b.x), py(b.y)] as [number, number]);

  // Contour rempli + bordé.
  const deltas = pts.slice(1).map(([x, y], i) => [x - pts[i][0], y - pts[i][1]] as [number, number]);
  doc.setFillColor(244, 246, 248);
  doc.setDrawColor(192, 57, 43);
  doc.setLineWidth(0.5);
  doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], "FD", true);

  // Bornes + étiquettes, écartées du centre de la parcelle.
  const ccx = px(cx);
  const ccy = py(cy);
  doc.setFontSize(7.5);
  bornes.forEach((b, i) => {
    const [x, y] = pts[i];
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.25);
    doc.circle(x, y, 0.9, "FD");

    let dx = x - ccx;
    let dy = y - ccy;
    const d = Math.hypot(dx, dy) || 1;
    dx = (dx / d) * 4;
    dy = (dy / d) * 4;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text(b.pt, x + dx, y + dy, { align: "center", baseline: "middle" });
  });

  // Longueur de chaque côté, au milieu du segment.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6.5);
  doc.setTextColor(31, 41, 51);
  const n = bornes.length;
  for (let i = 0; i < n; i++) {
    const a = bornes[i];
    const b = bornes[(i + 1) % n];
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    const long = Math.hypot(b.x - a.x, b.y - a.y);
    doc.text(long.toFixed(2), (ax + bx) / 2, (ay + by) / 2, {
      align: "center",
      baseline: "middle",
    });
  }

  f.y = oy + boiteMm + 3;
  f.texte("Longueurs des cotes en metres. Croquis sans echelle, controle visuel.", {
    taille: 7,
    italique: true,
    couleur: [107, 114, 128],
  });
}

/**
 * Construit le PV et déclenche son téléchargement dans le navigateur.
 */
export async function genererPv(rapport: VerifRapport, entete: EnTetePv): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const f = new Feuille(doc);

  // --- En-tête -------------------------------------------------------------
  f.texte("PROCES-VERBAL DE VERIFICATION", { taille: 16, gras: true });
  f.texte("Controle geometrique d'une parcelle reconstruite depuis son tableau de bornes X/Y", {
    taille: 8.5,
    italique: true,
    couleur: [107, 114, 128],
  });
  f.espace(3);

  const crsLib =
    entete.crsSource === "EPSG:32628"
      ? "EPSG:32628 - UTM 28N (RRS04)"
      : "EPSG:31028 - Yoff / UTM 28N";
  for (const [cle, valeur] of [
    ["Etabli le", dateFr(entete.date)],
    ["Operateur", entete.operateur || "non renseigne"],
    ["NICAD", entete.nicad || "non renseigne"],
    ["Systeme de coordonnees", crsLib],
    ["Origine des donnees", LIBELLE_SOURCE[entete.source]],
  ] as const) {
    f.place(5);
    f.y += 4.4;
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(107, 114, 128);
    doc.text(`${cle} :`, MARGIN, f.y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(15, 23, 42);
    doc.text(nettoyer(valeur), MARGIN + 46, f.y);
  }
  f.espace(5);

  // --- Verdict -----------------------------------------------------------
  const couleur = COULEUR_VERDICT[rapport.verdict];
  f.place(14);
  f.y += 2;
  doc.setFillColor(couleur[0], couleur[1], couleur[2]);
  doc.setDrawColor(couleur[0], couleur[1], couleur[2]);
  doc.setLineWidth(0.3);
  doc.setGState(doc.GState({ opacity: 0.12 }));
  doc.rect(MARGIN, f.y, CONTENT_W, 11, "F");
  doc.setGState(doc.GState({ opacity: 1 }));
  doc.rect(MARGIN, f.y, CONTENT_W, 11, "S");
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(couleur[0], couleur[1], couleur[2]);
  doc.text(VERDICT_LIBELLE[rapport.verdict].toUpperCase(), MARGIN + 4, f.y + 7.4);
  const compte = (s: "erreur" | "avertissement" | "info") =>
    rapport.anomalies.filter((a) => a.severite === s).length;
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(
    `${compte("erreur")} erreur(s), ${compte("avertissement")} avertissement(s)`,
    PAGE_W - MARGIN - 4,
    f.y + 7.2,
    { align: "right" },
  );
  f.y += 11;
  f.espace(3);

  // --- Croquis ---------------------------------------------------------------
  if (rapport.bornes.length >= 3) {
    f.titreSection("1. Croquis de la parcelle");
    dessinerCroquis(f, rapport.bornes);
  }

  // --- Superficie ----------------------------------------------------------
  f.titreSection("2. Superficie et perimetre");
  const m2 = rapport.superficieM2;
  f.texte(
    `Superficie calculee : ${m2.toFixed(2)} m2  -  ${(m2 / 100).toFixed(4)} ares  -  ${(m2 / 10000).toFixed(4)} ha`,
    { gras: true },
  );
  f.texte(
    `Perimetre : ${rapport.perimetreM.toFixed(2)} m  -  ${rapport.bornes.length} bornes  -  parcours ${rapport.sensHoraire ? "horaire" : "anti-horaire"}`,
  );
  if (rapport.ecartSuperficie) {
    const e = rapport.ecartSuperficie;
    f.texte(
      `Ecart avec la superficie declaree : ${e.absoluM2.toFixed(2)} m2 (${e.relatifPct.toFixed(2)} %), pour une tolerance de ${e.toleranceM2.toFixed(2)} m2.`,
    );
  } else {
    f.texte("Aucune superficie declaree n'a ete fournie : la comparaison n'a pas ete faite.", {
      italique: true,
      couleur: [107, 114, 128],
    });
  }

  // --- Bornes ------------------------------------------------------------
  f.titreSection("3. Tableau des bornes");
  f.tableau(
    ["Pts", "X (m)", "Y (m)"],
    rapport.bornes.map((b) => [b.pt, b.x.toFixed(4), b.y.toFixed(4)]),
    [22, 55, 55],
  );
  if (entete.crsSource === "EPSG:32628") {
    f.texte("Systeme de coordonnee : RRS04", {
      taille: 8,
      italique: true,
      couleur: [107, 114, 128],
    });
  }

  // --- Côtés -------------------------------------------------------------
  if (rapport.cotes.length) {
    f.titreSection("4. Cotes, longueurs et gisements");
    f.tableau(
      ["De", "Vers", "Longueur (m)", "Gisement (gon)"],
      rapport.cotes.map((c) => [
        c.de,
        c.vers,
        c.longueur.toFixed(2),
        c.gisement.toFixed(4),
      ]),
      [22, 22, 44, 44],
    );
    f.texte("Gisements de grille, comptes depuis le nord dans le sens horaire.", {
      taille: 8,
      italique: true,
      couleur: [107, 114, 128],
    });
  }

  // --- Anomalies -------------------------------------------------------------
  f.titreSection("5. Anomalies relevees");
  if (!rapport.anomalies.length) {
    f.texte("Aucune anomalie : la geometrie est coherente et la superficie conforme.", {
      couleur: COULEUR_VERDICT.CONFORME,
    });
  } else {
    for (const severite of ["erreur", "avertissement", "info"] as const) {
      const lot = rapport.anomalies.filter((a) => a.severite === severite);
      if (!lot.length) continue;
      f.espace(2);
      f.texte(`${LIBELLE_SEVERITE[severite]} (${lot.length})`, {
        gras: true,
        couleur:
          severite === "erreur"
            ? COULEUR_VERDICT.NON_CONFORME
            : severite === "avertissement"
              ? COULEUR_VERDICT.CONFORME_AVEC_RESERVE
              : [107, 114, 128],
      });
      for (const a of lot) {
        f.texte(`- [${a.code}] ${a.message}`, { taille: 8.5 });
      }
    }
  }

  // --- Portée du document -------------------------------------------------
  f.espace(6);
  f.texte(
    "Ce proces-verbal atteste du controle geometrique du tableau de coordonnees fourni. Il ne vaut ni authentification du document dont ces coordonnees sont issues, ni titre de propriete.",
    { taille: 7.5, italique: true, couleur: [107, 114, 128] },
  );

  // --- Pied de page ----------------------------------------------------------
  const total = (
    doc as unknown as { internal: { getNumberOfPages: () => number } }
  ).internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, PAGE_H - 10, PAGE_W - MARGIN, PAGE_H - 10);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text("GeoAino - Verification de bornes", MARGIN, PAGE_H - 5.5);
    doc.text(`Page ${p} / ${total}`, PAGE_W - MARGIN, PAGE_H - 5.5, { align: "right" });
  }

  const slug = (entete.nicad || "SANS-NICAD").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
  doc.save(`GEO-AINO_PV-verification_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
