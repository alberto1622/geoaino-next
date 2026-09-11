/**
 * Types du module « vérification de bornes » — reconstruit une parcelle à
 * partir d'un tableau de coordonnées X/Y et en contrôle la cohérence
 * géométrique. Porté depuis cadex-next (`src/lib/verif/`), adapté à
 * geoaino-next : pas de payload PDF ni d'OCR (aucun générateur de plan « Plan
 * Morcellement » ici) — voir `referentiel.ts` pour la voie NICAD → bornes.
 *
 * Ce fichier est **isomorphe** (importé par du code client comme serveur) :
 * il ne doit référencer aucune API Node.
 */

/** Une borne du tableau de coordonnées, en unités du CRS source (mètres). */
export type Borne = { pt: string; x: number; y: number };

export type Severite = "erreur" | "avertissement" | "info";

export type CodeAnomalie =
  | "BORNES_INSUFFISANTES"
  | "AUTO_INTERSECTION"
  | "HORS_EMPRISE"
  | "XY_INVERSES"
  | "UNITE_SUSPECTE"
  | "BORNES_CONFONDUES"
  | "BORNE_COLINEAIRE"
  | "NUMEROTATION_NON_CONFORME"
  | "ECART_SUPERFICIE";

/**
 * Correction applicable depuis l'interface. `INVERSER_SENS` n'est proposée
 * par aucune anomalie : le sens de parcours n'est pas un défaut (cf.
 * `sensHoraire` dans VerifRapport), c'est un outil manuel offert à l'opérateur.
 */
export type CodeCorrection =
  | "PERMUTER_XY"
  | "DIVISER_1000"
  | "INVERSER_SENS"
  | "RENUMEROTER";

export type Anomalie = {
  code: CodeAnomalie;
  severite: Severite;
  /** Message en français, prêt à afficher tel quel. */
  message: string;
  /** Index (0-based) des bornes concernées, pour le surlignage sur la carte. */
  bornes?: number[];
  correction?: CodeCorrection;
};

/** Un côté du polygone, de la borne `de` vers la borne `vers`. */
export type Cote = {
  de: string;
  vers: string;
  /** Longueur en mètres, dans le plan de projection. */
  longueur: number;
  /** Gisement en grades (gon) : 0 = nord de grille, sens horaire, [0 ; 400[. */
  gisement: number;
};

export type ErreurLigne = {
  /** Numéro de ligne dans le texte source, 1-based. */
  ligne: number;
  /** La ligne telle quelle, pour que l'opérateur la retrouve. */
  contenu: string;
  /** Motif du rejet, en français. */
  motif: string;
};

export type Verdict = "CONFORME" | "CONFORME_AVEC_RESERVE" | "NON_CONFORME";

/** CRS d'entrée acceptés (UTM 28N — RRS04 par défaut, Yoff pour un plan antérieur). */
export type CrsSource = "EPSG:32628" | "EPSG:31028";

export type VerifInput = {
  bornes: Borne[];
  crsSource: CrsSource;
  /** Superficie déclarée (saisie, ou reprise du référentiel), en m². */
  superficieDeclaree?: number;
  /** Tolérance relative en %, défaut TOLERANCE_PCT_DEFAUT. */
  tolerancePct?: number;
  /** Plancher absolu de tolérance en m², défaut TOLERANCE_PLANCHER_M2_DEFAUT. */
  tolerancePlancherM2?: number;
};

export type EcartSuperficie = {
  absoluM2: number;
  relatifPct: number;
  /** Tolérance effectivement appliquée, en m². */
  toleranceM2: number;
};

export type VerifRapport = {
  verdict: Verdict;
  /** Bornes renumérotées selon la convention CADEX (départ au Y maximal). */
  bornes: Borne[];
  /**
   * Polygone en WGS84 (EPSG:4326), anneau fermé et orienté anti-horaire
   * (RFC 7946). `null` quand les coordonnées sont rejetées — cf. core.ts.
   */
  geometry: GeoJSON.Polygon | null;
  superficieM2: number;
  perimetreM: number;
  /**
   * Sens de parcours des bornes : `true` = horaire.
   *
   * C'est une **observation, pas un défaut** (cf. cadex-next, échantillon de
   * 200 parcelles toutes en sens horaire) : en faire une anomalie alerterait
   * sur la quasi-totalité des parcelles légitimes.
   */
  sensHoraire: boolean;
  cotes: Cote[];
  anomalies: Anomalie[];
  ecartSuperficie?: EcartSuperficie;
};

/**
 * Origine des bornes, reportée sur le PV et dans l'historique.
 * - `saisie` / `fichier` — report humain (grille éditée, collage, .csv/.txt) ;
 * - `referentiel` — bornes reconstituées depuis `CadParcelle` par NICAD
 *   (commodité de saisie : ne *lit* aucun document, cf. referentiel.ts) ;
 * - `pdf-texte` — tableau lu dans la couche texte d'un plan PDF (exact) ;
 * - `pdf-referentiel` — NICAD lu sur le plan PDF, bornes reprises du référentiel ;
 * - `pdf-ocr` — tableau reconnu optiquement sur un plan PDF (à relire).
 */
export type SourceVerif =
  | "saisie"
  | "fichier"
  | "referentiel"
  | "pdf-texte"
  | "pdf-referentiel"
  | "pdf-ocr";

// --- Constantes partagées -----------------------------------------------------

export const TOLERANCE_PCT_DEFAUT = 0.5;
export const TOLERANCE_PLANCHER_M2_DEFAUT = 1;

/**
 * Emprise de plausibilité du Sénégal en UTM 28N (EPSG:32628), volontairement
 * large : le pays s'étend d'environ 17,6° W à 11,3° W, ce qui déborde à l'est
 * la zone 28 (18° W → 12° W) et produit des X au-delà de 800 000 en
 * projection étendue. Assez lâche pour tout le territoire, assez serrée pour
 * attraper une inversion X/Y ou un facteur 1000.
 */
export const EMPRISE = {
  xMin: 150_000,
  xMax: 1_000_000,
  yMin: 1_300_000,
  yMax: 1_900_000,
} as const;

/** Deux bornes plus proches que ce seuil (m) sont considérées confondues. */
export const SEUIL_CONFONDUES_M = 0.02;
/** Flèche (m) en deçà de laquelle un sommet est jugé colinéaire, donc inutile. */
export const SEUIL_COLINEAIRE_M = 0.02;
/**
 * Écart (m) en deçà duquel la dernière borne est jugée égale à la première,
 * donc retirée comme borne de fermeture redondante (cas d'un anneau GeoJSON).
 */
export const SEUIL_FERMETURE_M = 0.001;
