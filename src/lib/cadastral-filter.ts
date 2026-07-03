/**
 * Filtrage cadastral DGID pour les exports DXF/DGN issus de Microstation.
 *
 * Conserve les niveaux/calques officiels définis dans
 * "Etapes de travail sur Microstation.md" :
 * limites_parcelles, numero_parcelle, limites_sections, numero_section,
 * limites_tf, numero_tf, batiment, numero_batiment, nb_nv_bati, numero_lot,
 * titre_parcelle.
 * Exclut : historique_*, a_revoir_*, hachure, voirie, toponymie, cotation,
 * niveau, habillage, symbole.
 */

export interface GeoFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

export type CadastralClass =
  | "limites_parcelles"
  | "limites_sections"
  | "limites_tf"
  | "batiment"
  | "piscine"
  | "numero_parcelle"
  | "numero_section"
  | "numero_tf"
  | "numero_lot"
  | "numero_batiment"
  | "nb_nv_bati"
  | "titre_parcelle"
  | "proprietaire";

/**
 * Liste ordonnée des classes DGID exposée à l'interface (menu de mappage des
 * calques). Ordre = limites/emprises surfaciques d'abord, annotations ensuite.
 */
export const CADASTRAL_CLASSES: CadastralClass[] = [
  "limites_parcelles",
  "limites_sections",
  "limites_tf",
  "batiment",
  "piscine",
  "numero_parcelle",
  "numero_section",
  "numero_tf",
  "numero_lot",
  "numero_batiment",
  "nb_nv_bati",
  "titre_parcelle",
  "proprietaire",
];

/**
 * Mappage explicite calque → classe DGID validé par l'utilisateur (variante
 * « simple » : renommage des calques avant l'import). Les clés sont des noms de
 * calque NORMALISÉS (`normalizeText`). La valeur `"ignore"` exclut le calque.
 * Quand un calque figure ici, ce choix court-circuite l'heuristique
 * alias/flou de `classifyCadastralLayer`.
 */
export type LayerMapping = Record<string, CadastralClass | "ignore">;

export const SUPPORTED_VECTOR_TYPES = new Set([
  "Polygon",
  "MultiPolygon",
  "LineString",
  "MultiLineString",
  "GeometryCollection",
  "Point",
  "MultiPoint",
]);

// Classes "polygones/lignes" : limites de zones et emprises.
const POLYGON_LIKE_CLASSES: CadastralClass[] = [
  "limites_parcelles",
  "limites_sections",
  "limites_tf",
  "batiment",
  "piscine",
];

// Classes "annotations" : numéros, libellés (souvent des points/textes DXF).
const TEXT_LIKE_CLASSES: CadastralClass[] = [
  "numero_parcelle",
  "numero_section",
  "numero_tf",
  "numero_lot",
  "numero_batiment",
  "nb_nv_bati",
  "titre_parcelle",
  "proprietaire",
];

const CADASTRAL_ALLOWED_LAYERS: Record<CadastralClass, string[]> = {
  limites_parcelles: [
    "limites_parcelles",
    "limite_parcelle",
    "limites parcelles",
    "limite parcelle",
    "limites-parcelles",
    "limite-parcelle",
    "parcel_boundary",
    "parcelle_limite",
    "parcelle",
    "parcell",
    "parcel",
    // Alias issus des fichiers DGID (Saly Ngap / Rufisque).
    "limite_parcelles_saly_ngap",
    "limites_parcelles_saly_ngap",
    "parcelles_ruf",
    "parcelles_rufisque",
  ],
  limites_sections: [
    "limites_sections",
    "limite_section",
    "limites sections",
    "limite section",
    "limites-sections",
    "limite-section",
    "section_boundary",
    // Alias issus des fichiers DGID (Saly Ngap / Rufisque).
    "sections polygon",
    "sections_polygon",
    "section polygon",
    "sections rufisque",
    "sections rufisque 2016",
    "sections_rufisque_2016",
  ],
  limites_tf: [
    "limites_tf",
    "limite_tf",
    "limite tf",
    "limite-tf",
    "limitetf",
    "limite titre foncier",
    "limite_titre_foncier",
    "limites titre foncier",
    "limite l d tf",
    "titre foncier",
    "titre_foncier",
    "tf_limite",
  ],
  batiment: [
    "batiment",
    "bâtiment",
    "bati",
    "bâti",
    "building",
    "construction",
    "emprise_bati",
    "emprise_bâtie",
  ],
  // Emprises de piscines (calque PISCINES, fautes de frappe incluses : PICINES).
  piscine: [
    "piscine",
    "piscines",
    "picine",
    "picines",
    "pool",
    "bassin",
  ],
  numero_parcelle: [
    "numero_parcelle",
    "numero parcelle",
    // Pluriel « Numéros Parcelle » (calque DGID réel) : sans cet alias, le libellé
    // était capté par l'alias générique "parcelle" de limites_parcelles puis écarté
    // (Point incompatible avec une classe surfacique) → aucun numéro extrait.
    "numeros parcelle",
    "numeros_parcelle",
    "numeros-parcelle",
    "numeros parcelles",
    "num_parcelle",
    "num parcelle",
    "numparcelle",
    "numero-parcelle",
    "num-parcelle",
    "parcel_number",
    "no_parcelle",
    "n_parcelle",
    "na_parcelle",
  ],
  numero_section: [
    "numero_section",
    "numero section",
    "num_section",
    "num section",
    "numsection",
    "numero-section",
    "num-section",
    "section_number",
    "no_section",
  ],
  numero_tf: [
    "numero_tf",
    "numero tf",
    "num_tf",
    "num tf",
    "numtf",
    "n_tf",
    "na_tf",
    "no_tf",
  ],
  numero_lot: [
    "numero_lot",
    "numero lot",
    "num_lot",
    "num lot",
    "numlot",
    "n_lot",
    "na_lot",
    "no_lot",
    // Alias issus des fichiers DGID (Rufisque : "Numero lot, NUMERO D, N°LOT").
    "numero de lot",
    "numero d",
  ],
  numero_batiment: [
    "numero_batiment",
    "numero batiment",
    "num_batiment",
    "num batiment",
    "numero-batiment",
    "numero_bati",
    "num_bati",
    "n_bati",
    "na_bati",
    "no_bati",
  ],
  nb_nv_bati: [
    "nb_nv_bati",
    "nb nv bati",
    "nb-nv-bati",
    "nbnvbati",
    "nb_niveau_bati",
    "nb_niveau_batiment",
    "nombre_niveau_batiment",
    "nombre de niveau",
    "nombre_niveaux_batiment",
    "nb_etage",
    "nombre_etage",
  ],
  titre_parcelle: [
    "titre_parcelle",
    "titre parcelle",
    "titre-parcelle",
    "titreparcelle",
  ],
  // Propriétaire de la parcelle (calques PROPRIÉTAIRE, PROPRIETAIRE MAJ,
  // PROPRIETAIRES — les accents sont retirés par normalizeText).
  proprietaire: [
    "proprietaire",
    "proprietaires",
    "proprietaire maj",
    "propriete",
    "proprio",
  ],
};

const CADASTRAL_EXCLUDED_LAYERS = [
  "historique",
  "a_revoir",
  "a revoir",
  "revoir",
  "hachure",
  "hatch",
  "voirie",
  "route",
  "road",
  "toponymie",
  "toponyme",
  "texte_toponymie",
  "niveau",
  "level",
  "cotation",
  "cote",
  "habillage",
  "symbole",
];

// Plafonds modifiables via variables d'environnement si nécessaire.
const MAX_DXF_FEATURES_RETURNED = Number(process.env.MAX_DXF_FEATURES_RETURNED || 180000);
const MAX_DXF_TEXT_FEATURES = Number(process.env.MAX_DXF_TEXT_FEATURES || 60000);

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_\- ]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeFeatureCollection(value: unknown): FeatureCollection {
  if (!value || typeof value !== "object") {
    throw new Error("GeoJSON invalide : objet vide ou illisible");
  }

  const root = value as { type?: string; features?: unknown; geometry?: unknown };

  if (root.type === "FeatureCollection" && Array.isArray(root.features)) {
    return { type: "FeatureCollection", features: root.features.filter(Boolean) as GeoFeature[] };
  }

  if (root.type === "Feature" && root.geometry) {
    return { type: "FeatureCollection", features: [root as unknown as GeoFeature] };
  }

  throw new Error("GeoJSON invalide : FeatureCollection attendu");
}

export function filterUsefulFeatures(fc: FeatureCollection): FeatureCollection {
  const features = (fc.features || []).filter((feature) => {
    if (!feature || !feature.geometry) return false;
    return SUPPORTED_VECTOR_TYPES.has(feature.geometry.type);
  });
  return { type: "FeatureCollection", features };
}

function getLayerName(feature: GeoFeature): string {
  const props = feature?.properties || {};
  return normalizeText(
    props.Layer ??
    props.layer ??
    props.LEVEL ??
    props.Level ??
    props.Niveau ??
    props.niveau ??
    props.Calque ??
    props.calque ??
    props.Name ??
    props.name ??
    ""
  );
}

function getFeatureText(feature: GeoFeature): string {
  const props = feature?.properties || {};
  return normalizeText(
    props.Text ??
    props.text ??
    props.TEXT ??
    props.Label ??
    props.label ??
    props.Name ??
    props.name ??
    ""
  );
}

function isGeometryCompatibleWithClass(feature: GeoFeature, cls: CadastralClass): boolean {
  const type = feature?.geometry?.type ?? "";

  if (TEXT_LIKE_CLASSES.includes(cls)) {
    // Les annotations DXF peuvent sortir en Point, MultiPoint ou parfois GeometryCollection.
    return ["Point", "MultiPoint", "GeometryCollection", "LineString", "MultiLineString"].includes(type);
  }

  if (POLYGON_LIKE_CLASSES.includes(cls)) {
    return ["Polygon", "MultiPolygon", "LineString", "MultiLineString", "GeometryCollection"].includes(type);
  }

  return false;
}

// ───────────────────────────── Matching flou des calques ─────────────────────────────
//
// Quand un calque ne correspond à aucun alias connu (substring), on tente un
// rapprochement tolérant aux fautes de frappe et aux variantes non listées. La
// comparaison se fait token par token sur le NOM DE CALQUE uniquement — jamais
// sur le texte libre des annotations, pour éviter de classer un nom de
// propriétaire ou un numéro comme un calque. Les tokens courts (< 5 car.)
// exigent une égalité exacte : sur "tf", "lot", "n"… la tolérance créerait trop
// de faux positifs. Chaque token du mot-clé doit retrouver un équivalent dans
// le calque (moyenne) : "numero" seul ne suffit pas à classer numero_parcelle
// plutôt que numero_section.

const FUZZY_LAYER_THRESHOLD = Number(process.env.DXF_FUZZY_LAYER_THRESHOLD || 0.84);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Proximité d'un token de mot-clé vs un token de calque (0..1). */
function tokenMatch(keywordToken: string, layerToken: string): number {
  if (keywordToken === layerToken) return 1;
  // Tokens courts : aucune tolérance (collisions trop fréquentes).
  if (keywordToken.length < 5) return 0;
  const dist = levenshtein(keywordToken, layerToken);
  if (dist === 1) return 0.9;
  if (dist === 2 && keywordToken.length >= 8) return 0.8;
  return 0;
}

/**
 * Similarité d'un mot-clé (éventuellement multi-mots) avec l'ensemble des
 * tokens d'un nom de calque : chaque token du mot-clé doit retrouver un
 * équivalent parmi les tokens du calque, moyenné sur les tokens du mot-clé.
 */
function tokenSetSimilarity(layerTokens: string[], keyword: string): number {
  const kwTokens = keyword.split(/[ _-]+/).filter(Boolean);
  if (kwTokens.length === 0) return 0;
  let sum = 0;
  for (const kt of kwTokens) {
    let best = 0;
    for (const lt of layerTokens) {
      best = Math.max(best, tokenMatch(kt, lt));
      if (best === 1) break;
    }
    sum += best;
  }
  return sum / kwTokens.length;
}

// Mémoïsation : layer → candidats (déterministe, indépendant de la géométrie).
const fuzzyScoreCache = new Map<string, Array<{ cls: CadastralClass; score: number }>>();

/** Candidats de classe pour un nom de calque, par matching flou (mémoïsé). */
function fuzzyLayerCandidates(layer: string): Array<{ cls: CadastralClass; score: number }> {
  const cached = fuzzyScoreCache.get(layer);
  if (cached) return cached;

  const tokens = layer.split(/[ _-]+/).filter(Boolean);
  const scored: Array<{ cls: CadastralClass; score: number }> = [];
  if (tokens.length > 0) {
    for (const [cls, keywords] of Object.entries(CADASTRAL_ALLOWED_LAYERS) as Array<[CadastralClass, string[]]>) {
      let best = 0;
      for (const keyword of keywords) {
        best = Math.max(best, tokenSetSimilarity(tokens, normalizeText(keyword)));
        if (best === 1) break;
      }
      if (best >= FUZZY_LAYER_THRESHOLD) scored.push({ cls, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
  }

  fuzzyScoreCache.set(layer, scored);
  return scored;
}

interface LayerClassification {
  cls: CadastralClass;
  /**
   * "manual" = mappage explicite validé par l'utilisateur (priorité absolue) ;
   * "alias" = correspondance exacte/substring (haute confiance) ; "fuzzy" = repli flou.
   */
  method: "manual" | "alias" | "fuzzy";
}

/**
 * Propose une classe DGID pour un NOM DE CALQUE seul (sans texte d'annotation),
 * via correspondance alias (substring) puis matching flou. Retourne `null`
 * lorsque le calque est explicitement exclu ou qu'aucun rapprochement n'atteint
 * le seuil. Utilisé pour pré-remplir le tableau de mappage des calques (variante
 * « simple » : inventaire avant import).
 */
export function proposeClassForLayer(
  rawLayer: string,
): { cls: CadastralClass; method: "alias" | "fuzzy" } | null {
  const layer = normalizeText(rawLayer);
  if (!layer) return null;
  if (CADASTRAL_EXCLUDED_LAYERS.some((keyword) => layer.includes(normalizeText(keyword)))) {
    return null;
  }
  // Choisir la classe dont l'alias correspondant est le PLUS LONG (le plus
  // spécifique) : « numeros parcelle » contient à la fois "parcelle" (→
  // limites_parcelles) et "numeros parcelle" (→ numero_parcelle) ; sans ce
  // départage, l'alias générique "parcelle" l'emportait et pré-remplissait le
  // mappage sur limites_parcelles → libellés (Points) écartés → NICAD vide.
  let best: { cls: CadastralClass; len: number } | null = null;
  for (const [cls, keywords] of Object.entries(CADASTRAL_ALLOWED_LAYERS) as Array<[CadastralClass, string[]]>) {
    for (const keyword of keywords) {
      const k = normalizeText(keyword);
      if (k && layer.includes(k) && (best === null || k.length > best.len)) {
        best = { cls, len: k.length };
      }
    }
  }
  if (best) return { cls: best.cls, method: "alias" };

  const candidates = fuzzyLayerCandidates(layer);
  if (candidates.length === 0) return null;
  return { cls: candidates[0].cls, method: "fuzzy" };
}

function classifyCadastralLayer(
  feature: GeoFeature,
  layerMapping?: LayerMapping,
): LayerClassification | null {
  const layer = getLayerName(feature);

  // Mappage explicite validé par l'utilisateur : priorité sur l'heuristique.
  if (layerMapping && layer && Object.prototype.hasOwnProperty.call(layerMapping, layer)) {
    const mapped = layerMapping[layer];
    if (mapped === "ignore") return null;
    return { cls: mapped, method: "manual" };
  }

  const text = getFeatureText(feature);
  const haystack = `${layer} ${text}`;

  if (CADASTRAL_EXCLUDED_LAYERS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    return null;
  }

  // 1. Alias (substring) — haute confiance, sur layer + texte.
  const matches: CadastralClass[] = [];
  for (const [cls, keywords] of Object.entries(CADASTRAL_ALLOWED_LAYERS) as Array<[CadastralClass, string[]]>) {
    if (keywords.some((keyword) => haystack.includes(normalizeText(keyword)))) {
      matches.push(cls);
    }
  }

  if (matches.length > 0) {
    // Quand plusieurs classes correspondent (ex: "titre_foncier" générique),
    // privilégier celle dont le type de géométrie est compatible avec la feature.
    const cls = matches.find((c) => isGeometryCompatibleWithClass(feature, c)) ?? matches[0];
    return { cls, method: "alias" };
  }

  // 2. Matching flou — repli sur le NOM DE CALQUE uniquement (pas le texte).
  if (!layer) return null;
  const candidates = fuzzyLayerCandidates(layer);
  if (candidates.length === 0) return null;
  const cls =
    candidates.find((c) => isGeometryCompatibleWithClass(feature, c.cls))?.cls ?? candidates[0].cls;
  return { cls, method: "fuzzy" };
}

export interface DxfCadastralFilterOptions {
  /**
   * Plafond du nombre d'entités (et d'annotations) retournées.
   *  - `undefined` (défaut) : plafond HTTP `MAX_DXF_FEATURES_RETURNED` — à
   *    utiliser quand la sortie est sérialisée et renvoyée au client.
   *  - `null` : AUCUN plafond — à utiliser quand la sortie est intermédiaire
   *    (pipeline parcelle) : on garde toutes les entités pour construire toutes
   *    les parcelles, la réponse HTTP étant ensuite les parcelles, pas la FC.
   *  - nombre : plafond explicite.
   */
  maxFeatures?: number | null;
  /**
   * Mappage calque → classe DGID validé par l'utilisateur. Quand fourni, il
   * prime sur la classification automatique (alias/flou) pour les calques
   * qu'il référence. Les autres calques restent classés par heuristique.
   */
  layerMapping?: LayerMapping;
}

export function filterDxfCadastralFeatures(
  fc: FeatureCollection,
  options: DxfCadastralFilterOptions = {}
): FeatureCollection {
  const cap = options.maxFeatures === undefined ? MAX_DXF_FEATURES_RETURNED : options.maxFeatures;
  const uncapped = cap == null;
  const layerMapping = options.layerMapping;
  const useful = filterUsefulFeatures(fc).features;

  const buckets: Record<CadastralClass, GeoFeature[]> = {
    limites_parcelles: [],
    limites_sections: [],
    limites_tf: [],
    batiment: [],
    piscine: [],
    numero_parcelle: [],
    numero_section: [],
    numero_tf: [],
    numero_lot: [],
    numero_batiment: [],
    nb_nv_bati: [],
    titre_parcelle: [],
    proprietaire: [],
  };

  const detectedLayerNames = new Set<string>();
  // Calques rapprochés par matching flou (nom non conforme) → audit/traçabilité.
  const fuzzyMatchedLayers = new Map<string, CadastralClass>();

  for (const feature of useful) {
    const classification = classifyCadastralLayer(feature, layerMapping);
    if (!classification) continue;
    const { cls, method } = classification;
    if (!isGeometryCompatibleWithClass(feature, cls)) continue;

    const props = feature.properties || {};
    const layer = getLayerName(feature);
    if (layer) detectedLayerNames.add(layer);
    if (layer && method === "fuzzy") fuzzyMatchedLayers.set(layer, cls);

    buckets[cls].push({
      ...feature,
      properties: {
        ...props,
        _dgid_layer_class: cls,
        _dgid_layer_match: method,
        _dgid_original_layer: props.Layer ?? props.layer ?? props.Level ?? props.Niveau ?? props.Calque ?? null,
      },
    });
  }

  // Limiter les annotations, car elles peuvent exploser le volume JSON.
  // Sans plafond (pipeline parcelle), on conserve TOUTES les annotations : un
  // texte tronqué ici prive sa parcelle de numéro/propriétaire en aval.
  const textBucketsTrimmed: Record<string, GeoFeature[]> = {};
  for (const cls of TEXT_LIKE_CLASSES) {
    const limit = uncapped
      ? Infinity
      : cls === "numero_parcelle" || cls === "numero_section"
        ? MAX_DXF_TEXT_FEATURES
        : Math.min(MAX_DXF_TEXT_FEATURES, 20000);
    textBucketsTrimmed[cls] = buckets[cls].slice(0, limit);
  }

  const selected = [
    ...buckets.limites_parcelles,
    ...buckets.limites_sections,
    ...buckets.limites_tf,
    ...buckets.batiment,
    ...buckets.piscine,
    ...TEXT_LIKE_CLASSES.flatMap((cls) => textBucketsTrimmed[cls]),
  ];

  const audit = {
    inputFeatures: useful.length,
    selectedFeatures: selected.length,
    limitesParcelles: buckets.limites_parcelles.length,
    limitesSections: buckets.limites_sections.length,
    limitesTf: buckets.limites_tf.length,
    batiments: buckets.batiment.length,
    piscines: buckets.piscine.length,
    numeroParcelle: buckets.numero_parcelle.length,
    numeroSection: buckets.numero_section.length,
    numeroTf: buckets.numero_tf.length,
    numeroLot: buckets.numero_lot.length,
    numeroBatiment: buckets.numero_batiment.length,
    nbNvBati: buckets.nb_nv_bati.length,
    titreParcelle: buckets.titre_parcelle.length,
    proprietaire: buckets.proprietaire.length,
    numeroParcelleReturned: textBucketsTrimmed.numero_parcelle.length,
    numeroSectionReturned: textBucketsTrimmed.numero_section.length,
    detectedLayers: Array.from(detectedLayerNames).slice(0, 50),
    fuzzyMatchedLayers: Array.from(fuzzyMatchedLayers.entries())
      .slice(0, 50)
      .map(([layer, cls]) => `${layer} → ${cls}`),
  };

  console.log("[cadastral-filter] Audit filtrage cadastral DGID:", JSON.stringify(audit));

  if (selected.length === 0) {
    const sampleLayers = Array.from(new Set(useful.map(getLayerName).filter(Boolean))).slice(0, 40);

    // Fallback DGID permissif : certains DXF issus de Microstation/AutoCAD
    // ne conservent pas les noms de calques dans le GeoJSON final. Dans ce cas,
    // on ne bloque pas l'import : on garde un échantillon contrôlé de TOUTES les
    // géométries supportées, y compris les points/textes (souvent porteurs des
    // numéros de parcelles/sections), en limitant fortement le volume.
    const fallbackSource = useful.length > 0
      ? useful
      : (fc.features || []).filter((feature) => feature && feature.geometry);

    const fallbackSupported = fallbackSource.filter((feature) =>
      SUPPORTED_VECTOR_TYPES.has(feature?.geometry?.type ?? "")
    );
    const fallback = (uncapped ? fallbackSupported : fallbackSupported.slice(0, cap))
      .map((feature) => ({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          _dgid_layer_class: "fallback_geometrie",
          _dgid_warning: "Calque DXF non lisible : fallback géométrique permissif appliqué",
        },
      }));

    if (fallback.length === 0) {
      // Dernier recours : message clair, mais seulement si aucune géométrie n'existe réellement.
      throw new Error([
        "Aucune géométrie exploitable n'a été trouvée dans le DXF après conversion OGR.",
        "",
        "Cela signifie que le DXF contient probablement des objets non géométriques ou que l'export Microstation n'a pas inclus les entités graphiques.",
        "Calques attendus : limites_parcelles, numero_parcelle, limites_sections, numero_section, limites_tf, numero_tf, batiment, numero_batiment, nb_nv_bati, numero_lot, titre_parcelle.",
        sampleLayers.length ? `Calques détectés : ${sampleLayers.join(", ")}` : "Aucun nom de calque lisible détecté.",
      ].join("\n"));
    }

    console.warn(
      `[cadastral-filter] DXF sans calques lisibles : fallback géométrique permissif appliqué (${fallback.length}/${fallbackSource.length} entités conservées).`
    );

    return { type: "FeatureCollection", features: fallback };
  }

  // Troncature uniquement quand la FC est un payload HTTP (cap défini). Le
  // pipeline parcelle appelle avec `maxFeatures: null` : aucune entité n'est
  // jetée avant l'assemblage des parcelles (la réponse HTTP est ensuite la
  // liste des parcelles, bien plus petite que la FC intermédiaire).
  if (!uncapped && selected.length > cap) {
    console.warn(
      `[cadastral-filter] DXF volumineux : ${selected.length} entités filtrées, ` +
      `tronqué à ${cap} pour éviter PayloadTooLarge (payload HTTP).`
    );
    const trimmed = selected.slice(0, cap).map((feature) => ({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        _dgid_truncated: true,
        _dgid_warning: "DXF volumineux : sélection cadastrale tronquée côté serveur",
      },
    }));
    return { type: "FeatureCollection", features: trimmed };
  }

  return { type: "FeatureCollection", features: selected };
}
