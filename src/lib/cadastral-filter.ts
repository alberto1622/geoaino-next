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

type CadastralClass =
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
const MAX_DXF_FEATURES_HARD = Number(process.env.MAX_DXF_FEATURES_HARD || 220000);
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

function classifyCadastralLayer(feature: GeoFeature): CadastralClass | null {
  const layer = getLayerName(feature);
  const text = getFeatureText(feature);
  const haystack = `${layer} ${text}`;

  if (CADASTRAL_EXCLUDED_LAYERS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    return null;
  }

  const matches: CadastralClass[] = [];
  for (const [cls, keywords] of Object.entries(CADASTRAL_ALLOWED_LAYERS) as Array<[CadastralClass, string[]]>) {
    if (keywords.some((keyword) => haystack.includes(normalizeText(keyword)))) {
      matches.push(cls);
    }
  }

  if (matches.length === 0) return null;

  // Quand plusieurs classes correspondent (ex: "titre_foncier" générique),
  // privilégier celle dont le type de géométrie est compatible avec la feature.
  return matches.find((cls) => isGeometryCompatibleWithClass(feature, cls)) ?? matches[0];
}

export function filterDxfCadastralFeatures(fc: FeatureCollection): FeatureCollection {
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

  for (const feature of useful) {
    const cls = classifyCadastralLayer(feature);
    if (!cls) continue;
    if (!isGeometryCompatibleWithClass(feature, cls)) continue;

    const props = feature.properties || {};
    const layer = getLayerName(feature);
    if (layer) detectedLayerNames.add(layer);

    buckets[cls].push({
      ...feature,
      properties: {
        ...props,
        _dgid_layer_class: cls,
        _dgid_original_layer: props.Layer ?? props.layer ?? props.Level ?? props.Niveau ?? props.Calque ?? null,
      },
    });
  }

  // Limiter les annotations, car elles peuvent exploser le volume JSON.
  const textBucketsTrimmed: Record<string, GeoFeature[]> = {};
  for (const cls of TEXT_LIKE_CLASSES) {
    const limit = cls === "numero_parcelle" || cls === "numero_section"
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

    const fallback = fallbackSource
      .filter((feature) => SUPPORTED_VECTOR_TYPES.has(feature?.geometry?.type ?? ""))
      .slice(0, MAX_DXF_FEATURES_RETURNED)
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

  if (selected.length > MAX_DXF_FEATURES_HARD) {
    console.warn(
      `[cadastral-filter] DXF encore volumineux après filtrage intelligent : ${selected.length} entités. ` +
      `Tronqué à ${MAX_DXF_FEATURES_RETURNED} pour éviter PayloadTooLarge.`
    );
    const trimmed = selected.slice(0, MAX_DXF_FEATURES_RETURNED).map((feature) => ({
      ...feature,
      properties: {
        ...(feature.properties || {}),
        _dgid_truncated: true,
        _dgid_warning: "DXF volumineux : sélection cadastrale tronquée côté serveur",
      },
    }));
    return { type: "FeatureCollection", features: trimmed };
  }

  if (selected.length > MAX_DXF_FEATURES_RETURNED) {
    console.warn(
      `[cadastral-filter] DXF massif : ${selected.length} entités filtrées. Tronqué à ${MAX_DXF_FEATURES_RETURNED}.`
    );
    return { type: "FeatureCollection", features: selected.slice(0, MAX_DXF_FEATURES_RETURNED) };
  }

  return { type: "FeatureCollection", features: selected };
}
