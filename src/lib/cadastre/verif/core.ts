/**
 * Noyau de vérification — reconstruit une parcelle à partir de son tableau de
 * bornes X/Y et en contrôle la cohérence géométrique. Porté depuis cadex-next
 * (`src/lib/verif/core.ts`), inchangé (module pur, sans dépendance au reste
 * de ce projet-là).
 *
 * **Isomorphe** : exécuté tel quel dans le navigateur (aperçu instantané) et
 * sur le serveur (résultat faisant foi, persisté et imprimé sur le PV). Seule
 * dépendance : proj4. Aucune API Node, pas de jsts — la détection
 * d'auto-intersection est écrite à la main en O(n²), sans effet mesurable sur
 * des parcelles de 4 à 20 sommets.
 */

import proj4 from "proj4";
import {
  Anomalie,
  Borne,
  Cote,
  EMPRISE,
  EcartSuperficie,
  SEUIL_COLINEAIRE_M,
  SEUIL_CONFONDUES_M,
  SEUIL_FERMETURE_M,
  TOLERANCE_PCT_DEFAUT,
  TOLERANCE_PLANCHER_M2_DEFAUT,
  VerifInput,
  VerifRapport,
  Verdict,
} from "./types";

// Définitions proj4. proj4.defs est idempotent : une double déclaration (si le
// reste du projet définit déjà EPSG:32628 ailleurs) est sans effet.
proj4.defs("EPSG:32628", "+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs +type=crs");
proj4.defs(
  "EPSG:31028",
  "+proj=utm +zone=28 +a=6378249.2 +b=6356515 +towgs84=-83,37,124,0,0,0,0 +units=m +no_defs +type=crs",
);

// --- Helpers géométriques -----------------------------------------------------

const dist = (a: Borne, b: Borne) => Math.hypot(b.x - a.x, b.y - a.y);

/** Aire signée (shoelace). Positive = sens anti-horaire (repère X vers l'est, Y vers le nord). */
function aireSignee(bornes: Borne[]): number {
  let s = 0;
  for (let i = 0; i < bornes.length; i++) {
    const a = bornes[i];
    const b = bornes[(i + 1) % bornes.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Distance du point `p` au segment [a, b] — la « flèche » du sommet. */
function fleche(p: Borne, a: Borne, b: Borne): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Orientation du triplet : >0 anti-horaire, <0 horaire, 0 colinéaire. */
function orientation(a: Borne, b: Borne, c: Borne): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function surSegment(a: Borne, b: Borne, p: Borne): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Deux segments propres se croisent-ils ? (cas colinéaires inclus) */
function segmentsSeCroisent(p1: Borne, p2: Borne, p3: Borne, p4: Borne): boolean {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;

  if (d1 === 0 && surSegment(p3, p4, p1)) return true;
  if (d2 === 0 && surSegment(p3, p4, p2)) return true;
  if (d3 === 0 && surSegment(p1, p2, p3)) return true;
  if (d4 === 0 && surSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * Paires de côtés non adjacents qui se croisent. On exclut les côtés voisins,
 * qui partagent légitimement une extrémité.
 */
function autoIntersections(bornes: Borne[]): Array<[number, number]> {
  const n = bornes.length;
  const paires: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Côtés adjacents (ou premier/dernier, qui se touchent aussi) : ignorés.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsSeCroisent(bornes[i], bornes[(i + 1) % n], bornes[j], bornes[(j + 1) % n]))
        paires.push([i, j]);
    }
  }
  return paires;
}

/** Une borne est-elle dans l'emprise plausible du Sénégal en UTM 28N ? */
const dansEmprise = (b: Borne) =>
  b.x >= EMPRISE.xMin && b.x <= EMPRISE.xMax && b.y >= EMPRISE.yMin && b.y <= EMPRISE.yMax;

/**
 * Renumérote les bornes selon la convention CADEX : rotation de la liste pour
 * démarrer au sommet de Y maximal, sens de parcours inchangé.
 *
 * **Égalités** — une parcelle rectangulaire a deux sommets au même Y maximal.
 * La comparaison est volontairement stricte (`>`), donc le premier rencontré
 * dans l'ordre de saisie l'emporte.
 */
function renumeroter(bornes: Borne[]): { bornes: Borne[]; decale: boolean } {
  let hi = 0;
  for (let i = 1; i < bornes.length; i++) if (bornes[i].y > bornes[hi].y) hi = i;
  const tourne = bornes.slice(hi).concat(bornes.slice(0, hi));
  return {
    bornes: tourne.map((b, i) => ({ ...b, pt: `B${i + 1}` })),
    decale: hi !== 0,
  };
}

/** Gisement en grades (gon) : 0 = nord de grille, sens horaire, [0 ; 400[. */
function gisementGon(a: Borne, b: Borne): number {
  const g = (Math.atan2(b.x - a.x, b.y - a.y) * 200) / Math.PI;
  return (g + 400) % 400;
}

// --- Vérification -------------------------------------------------------------

/**
 * Vérifie un tableau de bornes et produit le rapport complet.
 *
 * Ne lève jamais : toute entrée, même absurde, ressort sous forme d'anomalies.
 */
export function verifier(input: VerifInput): VerifRapport {
  const anomalies: Anomalie[] = [];
  const crs = input.crsSource;
  const tolerancePct = input.tolerancePct ?? TOLERANCE_PCT_DEFAUT;
  const tolerancePlancherM2 = input.tolerancePlancherM2 ?? TOLERANCE_PLANCHER_M2_DEFAUT;

  // 1. Normalisation : la fermeture est implicite partout dans le module, donc
  //    `bornes` ne contient que des sommets distincts. Un tableau CADEX ne
  //    répète jamais B1 en fin de liste ; le cas est donc la norme et ne
  //    produit aucune anomalie. On absorbe seulement un anneau explicitement
  //    fermé, tel qu'en produit un export GeoJSON. Une borne de fermeture mal
  //    ressaisie (proche de B1 sans lui être égale) est attrapée plus bas par
  //    BORNES_CONFONDUES.
  let bornes = input.bornes.map((b) => ({ ...b }));
  if (bornes.length >= 2 && dist(bornes[0], bornes[bornes.length - 1]) < SEUIL_FERMETURE_M) {
    bornes = bornes.slice(0, -1);
  }

  if (bornes.length < 3) {
    anomalies.push({
      code: "BORNES_INSUFFISANTES",
      severite: "erreur",
      message: `Il faut au moins 3 bornes distinctes pour former une parcelle (${bornes.length} fournie${bornes.length > 1 ? "s" : ""}).`,
    });
    return rapportRejete(bornes, anomalies);
  }

  // 2. Contrôles de plausibilité des coordonnées, dans l'ordre : une hypothèse
  //    correctrice qui ramène TOUTES les bornes dans l'emprise l'emporte et
  //    exclut les suivantes. Tant que les coordonnées sont douteuses, aucune
  //    métrique n'est produite : afficher une superficie calculée sur des X/Y
  //    manifestement mal saisis induirait en erreur.
  if (!bornes.every(dansEmprise)) {
    const permutees = bornes.map((b) => ({ ...b, x: b.y, y: b.x }));
    const divisees = bornes.map((b) => ({ ...b, x: b.x / 1000, y: b.y / 1000 }));
    const horsEmprise = bornes.map((b, i) => (dansEmprise(b) ? -1 : i)).filter((i) => i >= 0);

    if (permutees.every(dansEmprise)) {
      anomalies.push({
        code: "XY_INVERSES",
        severite: "erreur",
        message:
          "Les colonnes X et Y semblent permutées : les coordonnées ne tombent dans l'emprise du Sénégal qu'une fois échangées.",
        bornes: horsEmprise,
        correction: "PERMUTER_XY",
      });
    } else if (divisees.every(dansEmprise)) {
      anomalies.push({
        code: "UNITE_SUSPECTE",
        severite: "erreur",
        message:
          "Les coordonnées semblent exprimées en kilomètres : elles ne tombent dans l'emprise du Sénégal qu'une fois divisées par 1000.",
        bornes: horsEmprise,
        correction: "DIVISER_1000",
      });
    } else {
      anomalies.push({
        code: "HORS_EMPRISE",
        severite: "erreur",
        message: `${horsEmprise.length} borne${horsEmprise.length > 1 ? "s sortent" : " sort"} de l'emprise du Sénégal en UTM 28N (X ∈ [${EMPRISE.xMin} ; ${EMPRISE.xMax}], Y ∈ [${EMPRISE.yMin} ; ${EMPRISE.yMax}]).`,
        bornes: horsEmprise,
      });
    }
    return rapportRejete(bornes, anomalies);
  }

  // 3. Renumérotation selon la convention CADEX.
  const { bornes: ordonnees, decale } = renumeroter(bornes);
  if (decale) {
    anomalies.push({
      code: "NUMEROTATION_NON_CONFORME",
      severite: "avertissement",
      message:
        "La numérotation saisie ne suit pas la convention CADEX : B1 doit être la borne la plus au nord (Y maximal). Les bornes ont été renumérotées dans le rapport.",
      correction: "RENUMEROTER",
    });
  }

  // 4. Métriques.
  const n = ordonnees.length;
  const cotes: Cote[] = [];
  let perimetreM = 0;
  for (let i = 0; i < n; i++) {
    const a = ordonnees[i];
    const b = ordonnees[(i + 1) % n];
    const longueur = dist(a, b);
    perimetreM += longueur;
    cotes.push({ de: a.pt, vers: b.pt, longueur, gisement: gisementGon(a, b) });
  }
  const aire = aireSignee(ordonnees);
  const superficieM2 = Math.abs(aire);

  // 5. Contrôles géométriques.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dist(ordonnees[i], ordonnees[j]) < SEUIL_CONFONDUES_M) {
        anomalies.push({
          code: "BORNES_CONFONDUES",
          severite: "avertissement",
          message: `${ordonnees[i].pt} et ${ordonnees[j].pt} sont distantes de moins de ${(SEUIL_CONFONDUES_M * 100).toFixed(0)} cm : elles décrivent vraisemblablement la même borne.`,
          bornes: [i, j],
        });
      }
    }
  }

  const croisements = autoIntersections(ordonnees);
  for (const [i, j] of croisements) {
    const a = ordonnees[i].pt;
    const b = ordonnees[(i + 1) % n].pt;
    const c = ordonnees[j].pt;
    const d = ordonnees[(j + 1) % n].pt;
    anomalies.push({
      code: "AUTO_INTERSECTION",
      severite: "erreur",
      message: `Les côtés ${a}–${b} et ${c}–${d} se croisent : le contour se recoupe, ce n'est pas une parcelle valide.`,
      bornes: [i, (i + 1) % n, j, (j + 1) % n],
    });
  }

  for (let i = 0; i < n; i++) {
    const p = ordonnees[i];
    const a = ordonnees[(i - 1 + n) % n];
    const b = ordonnees[(i + 1) % n];
    if (dist(a, p) < SEUIL_CONFONDUES_M || dist(p, b) < SEUIL_CONFONDUES_M) continue;
    if (fleche(p, a, b) < SEUIL_COLINEAIRE_M) {
      anomalies.push({
        code: "BORNE_COLINEAIRE",
        severite: "avertissement",
        message: `${p.pt} est alignée sur ${a.pt}–${b.pt} (écart inférieur à ${(SEUIL_COLINEAIRE_M * 100).toFixed(0)} cm) : ce sommet n'apporte rien au contour.`,
        bornes: [i],
      });
    }
  }

  // 6. Comparaison à la superficie déclarée.
  let ecartSuperficie: EcartSuperficie | undefined;
  if (typeof input.superficieDeclaree === "number" && input.superficieDeclaree > 0) {
    const declaree = input.superficieDeclaree;
    const toleranceM2 = Math.max((declaree * tolerancePct) / 100, tolerancePlancherM2);
    const absoluM2 = Math.abs(superficieM2 - declaree);
    ecartSuperficie = {
      absoluM2,
      relatifPct: (absoluM2 / declaree) * 100,
      toleranceM2,
    };
    if (absoluM2 > toleranceM2) {
      const grave = absoluM2 > 2 * toleranceM2;
      anomalies.push({
        code: "ECART_SUPERFICIE",
        severite: grave ? "erreur" : "avertissement",
        message: `Superficie calculée ${superficieM2.toFixed(2)} m² contre ${declaree.toFixed(2)} m² déclarés : écart de ${absoluM2.toFixed(2)} m² (${ecartSuperficie.relatifPct.toFixed(2)} %), pour une tolérance de ${toleranceM2.toFixed(2)} m².`,
      });
    }
  }

  // 7. Géométrie WGS84, anneau fermé et orienté anti-horaire (RFC 7946).
  const sens = aire < 0 ? [...ordonnees].reverse() : ordonnees;
  const anneau = sens.map((b) => proj4(crs, "EPSG:4326", [b.x, b.y]) as [number, number]);
  anneau.push(anneau[0]);
  const geometry: GeoJSON.Polygon = { type: "Polygon", coordinates: [anneau] };

  return {
    verdict: verdictDe(anomalies),
    bornes: ordonnees,
    geometry,
    superficieM2,
    perimetreM,
    sensHoraire: aire < 0,
    cotes,
    anomalies,
    ecartSuperficie,
  };
}

/** Rapport renvoyé quand les coordonnées elles-mêmes sont rejetées. */
function rapportRejete(bornes: Borne[], anomalies: Anomalie[]): VerifRapport {
  return {
    verdict: "NON_CONFORME",
    bornes,
    geometry: null,
    superficieM2: 0,
    perimetreM: 0,
    sensHoraire: false,
    cotes: [],
    anomalies,
  };
}

function verdictDe(anomalies: Anomalie[]): Verdict {
  if (anomalies.some((a) => a.severite === "erreur")) return "NON_CONFORME";
  if (anomalies.some((a) => a.severite === "avertissement")) return "CONFORME_AVEC_RESERVE";
  return "CONFORME";
}

// --- Corrections applicables depuis l'interface --------------------------------

/**
 * Applique une correction proposée par une anomalie. Renvoie une nouvelle
 * liste de bornes ; l'appelant relance `verifier()` dessus.
 */
export function appliquerCorrection(
  bornes: Borne[],
  correction: NonNullable<Anomalie["correction"]>,
): Borne[] {
  switch (correction) {
    case "PERMUTER_XY":
      return bornes.map((b) => ({ ...b, x: b.y, y: b.x }));
    case "DIVISER_1000":
      return bornes.map((b) => ({ ...b, x: b.x / 1000, y: b.y / 1000 }));
    case "INVERSER_SENS": {
      // Inverser le sens de parcours en gardant la première borne en tête.
      if (bornes.length < 2) return bornes;
      const [tete, ...suite] = bornes;
      return [tete, ...suite.reverse()].map((b, i) => ({ ...b, pt: `B${i + 1}` }));
    }
    case "RENUMEROTER":
      return renumeroter(bornes).bornes;
  }
}

// --- Formatage ----------------------------------------------------------------

export const VERDICT_LIBELLE: Record<Verdict, string> = {
  CONFORME: "Conforme",
  CONFORME_AVEC_RESERVE: "Conforme avec réserve",
  NON_CONFORME: "Non conforme",
};

/** Gisement en degrés décimaux, pour l'affichage alternatif. */
export const gonEnDegres = (gon: number) => (gon * 360) / 400;

/** Superficie en m², ares et hectares — les trois unités portées sur les plans. */
export function superficieUnites(m2: number): { m2: number; ares: number; ha: number } {
  return { m2, ares: m2 / 100, ha: m2 / 10000 };
}
