# Documentation du projet GEO-AINO

Plateforme web (Next.js + PostgreSQL) d'analyse, de contrôle qualité et de correction de données cadastrales (parcelles GeoJSON / Shapefile), avec assistance IA.

> Pour le détail pas-à-pas du pipeline détection → correction, voir aussi [`CORRECTION_PROCESS.md`](./CORRECTION_PROCESS.md). Ce document couvre l'ensemble du projet : base de données, stockage, détection, correction (auto + manuelle), rapports et IA.

---

## 1. Architecture générale

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  Upload SHP │────▶│ /api/upload-geo   │────▶│ GeoJSON (WGS84)     │
│  / GeoJSON  │     │ (parse + reproj.) │     │                     │
└─────────────┘     └──────────────────┘     └─────────┬───────────┘
                                                          ▼
                                              ┌────────────────────────┐
                                              │ POST /api/analyses      │
                                              │  - saveGeoJsonLocally   │ → fichier sur disque (uploads/geojson/)
                                              │  - analyzeGeoJSON()     │ → erreurs topologiques
                                              │  - generateAIReport()   │ → rapport Markdown (LLM)
                                              └─────────┬──────────────┘
                                                          ▼
                                   ┌─────────────────────────────────────┐
                                   │ PostgreSQL (Prisma)                  │
                                   │  Analysis, TopologicalError, Report, │
                                   │  AdminLayer, AiConversation, ...     │
                                   └─────────────────┬─────────────────────┘
                                                          ▼
                        ┌─────────────────────────────────────────────────┐
                        │ Vue carte (MapAnalysisClient)                    │
                        │  - liste des erreurs                             │
                        │  - correction guidée    → /errors/[id]/correct   │
                        │    (manuelle, erreur par erreur)                 │
                        │  - chat IA              → /api/ai/chat            │
                        │  - export rapport PDF   → /api/reports            │
                        └─────────────────────────────────────────────────┘
```

### Stack technique
- **Next.js (App Router)** — pages + Route Handlers (`src/app/api/**`)
- **Prisma + PostgreSQL** — persistance (`prisma/schema.prisma`)
- **Turf.js** + **proj4** — géotraitement (intersections, unions, reprojection UTM↔WGS84)
- **NextAuth** — authentification (`src/lib/auth.ts`)
- **LLM** (OpenAI/Groq, avec fallback statique) — rapports et chat (`src/lib/llm.ts`)
- **Leaflet / MapLibre** — affichage cartographique (`src/components/LeafletMap.tsx`, `MapLibreMap.tsx`)

---

## 2. Base de données (`prisma/schema.prisma`)

### 2.1 `Analysis` — une analyse = un fichier uploadé

| Champ | Type | Rôle |
|---|---|---|
| `id` | Int | Identifiant de l'analyse |
| `fileName`, `fileFormat`, `fileSize` | — | Métadonnées du fichier source |
| `status` | `PENDING / PROCESSING / COMPLETED / FAILED` | État du traitement |
| `totalFeatures` | Int | Nombre de parcelles analysées |
| `errorCount` | Int | Nombre d'erreurs détectées |
| `conformityScore` | Decimal(5,2) | Score de conformité (0–100) |
| `totalSurface` | Decimal(20,4) | Surface cumulée |
| `commune`, `region`, `crs` | String? | Contexte géographique |
| `geojsonKey` | String? | Clé/chemin vers le fichier GeoJSON brut sur disque (`local:uploads/geojson/...`) |
| `geoJsonData` | Text | Historique : copie brute en base (souvent vide `{features:[]}` pour les gros fichiers, le fichier disque fait foi) |
| `adminBoundaryData` | Text? | GeoJSON de la limite administrative fournie à l'upload |
| `correctedData` | Text? | **GeoJSON corrigé courant** — mis à jour à chaque correction (auto ou manuelle) |
| `summaryStats` | Json? | Statistiques globales (`AnalysisResult.stats`) |
| `aiReport` | Text? | Rapport Markdown généré par le LLM |

**Relations** : `topologicalErrors`, `reports`, `overlapGeometries`, `geoEngineResults`, `geoprocessingOps`, `aiConversations`.

### 2.2 `TopologicalError` — une erreur détectée

| Champ | Rôle |
|---|---|
| `analysisId` | Analyse parente |
| `errorType` | `OVERLAP, GAP, SLIVER, DUPLICATE, INVALID_GEOM, BOUNDARY_CROSS, MISSING_NICAD, SELF_INTERSECT` |
| `severity` | `CRITICAL, HIGH, MEDIUM, LOW` |
| `nicad1` / `nicad2` | Identifiant(s) de la/les parcelle(s) concernée(s). Soit un vrai NICAD, soit un identifiant synthétique `feature_<idx>` si la parcelle n'a pas de NICAD au moment de l'analyse |
| `description` | Texte explicatif (FR) |
| `geometry` | Géométrie GeoJSON de la zone en erreur (intersection, sliver, gap, parcelle...) — utilisée pour l'affichage carte **et** pour retrouver la parcelle lors d'une correction manuelle |
| `area` | Surface en m² (si pertinent) |
| `confidence` | Indice de confiance [0–1] |
| `corrected` | `false` par défaut, passe à `true` une fois traitée |
| `correctionGeometry` | Géométrie résultante après correction (union, découpe, troncature...) |

> ⚠️ **Identifiants `feature_<idx>`** : `idx` correspond à la position de la feature dans le tableau `features` **au moment de l'analyse**. Si des features sont supprimées par des corrections ultérieures, les index suivants se décalent — `feature_<idx>` devient « périmé ». Le endpoint de correction gère ce cas (voir §5.1).

### 2.3 `Report`

Rapports générés et conservés pour une analyse (`SUMMARY`, `DETAILED`, `EXPERT`, `CORRECTION`). Le contenu (`content`) est en général une copie de `Analysis.aiReport`.

### 2.4 `AdminLayer`

Couches administratives (commune, département, région, section, îlot) pouvant être réutilisées comme limite de référence pour la détection `BOUNDARY_CROSS`.

### 2.5 `OverlapGeometry`, `GeoEngineResult`, `GeoprocessingOp`

Tables prévues pour stocker des résultats de géotraitement détaillés (chevauchements individuels, gaps, statistiques zonales, opérations buffer/union/...). Peu ou pas encore alimentées par le moteur actuel — réservées à des évolutions futures.

### 2.6 `AiConversation`

Historique des échanges du chat IA (`role: USER/ASSISTANT`, `content`, `context` JSON), liés à une analyse et/ou un utilisateur.

### 2.7 Auth (`User`, `Account`, `Session`, `VerificationToken`)

Tables standard NextAuth. `User.role` (`USER` / `ADMIN`) sert au contrôle d'accès.

---

## 3. Stockage des fichiers GeoJSON (`src/lib/geo-storage.ts`)

Les GeoJSON volumineux ne sont **pas** stockés en base (la colonne `geoJsonData` reste souvent `{features:[]}`). Ils sont écrits sur disque :

- `saveGeoJsonLocally(fileName, data, userId)` → écrit dans `uploads/geojson/<userId>_<timestamp>_<nom>.geojson` et retourne une clé `local:<chemin>`
- `loadGeoJsonFromKey(key)` → relit le fichier (gère aussi les anciennes clés sans préfixe `local:`)
- `writeGeoJsonByKey(key, data)` → réécrit le fichier (utilisé par `/api/analyses/[id]/features`)
- `deleteGeoJsonByKey(key)` → supprime le fichier (à la suppression d'une analyse)

**Ordre de priorité de lecture** dans toutes les routes : `analysis.correctedData ?? loadGeoJsonFromKey(analysis.geojsonKey) ?? analysis.geoJsonData`.

---

## 4. Détection des erreurs (`analyzeGeoJSON`, `src/lib/geo-engine.ts`)

Déclenchée à l'upload via `POST /api/analyses`. 4 passes séquentielles sur `geojson.features` :

| Passe | Vérification | Erreur(s) générée(s) | Sévérité |
|---|---|---|---|
| 1 | Géométrie nulle/invalide | `INVALID_GEOM` | CRITICAL |
| 1 | NICAD absent / `< 8` caractères / valeurs type "N/A", "0", "néant"... | `MISSING_NICAD` | CRITICAL |
| 1 | Surface quasi nulle ou ratio L/l > 50 | `SLIVER` | MEDIUM |
| 2 | NICAD dupliqué (≥ 2 occurrences) | `DUPLICATE` (1 erreur par occurrence) | CRITICAL |
| 3a | Chevauchement géométrique réel (Turf, max 500 features, max 200 erreurs) | `OVERLAP` | LOW → CRITICAL selon % de recouvrement |
| 3b | Espace vide entre parcelles (3 à 300 features) | `GAP` | MEDIUM / HIGH selon surface |
| 4 | Parcelle hors limite administrative fournie | `BOUNDARY_CROSS` | HIGH |

**Extraction du NICAD** (`extractNicad`) : cherche dans l'ordre `nicad → NICAD → Nicad → NIC → NUM_NICAD → num_nicad → CODE_NICAD → code_nicad → CODIF → codif`.

**Score de conformité** :
```
Pénalité = (CRITICAL × 10) + (HIGH × 5) + (MEDIUM × 2)
Score    = max(0, min(100, 100 − (Pénalité / nb_parcelles) × 10))
```

**Reprojection** : si les coordonnées de la 1ʳᵉ feature sont en UTM (`|x| > 180`), reprojection automatique UTM zone 28N → WGS84 via `proj4` pour les calculs de chevauchement/gap (limité au Sénégal occidental).

Détails complets, tableaux et limites connues : voir [`CORRECTION_PROCESS.md`](./CORRECTION_PROCESS.md#phase-1--détection-des-erreurs-analyzegeojson).

---

## 5. Correction des erreurs

Toutes les corrections sont **manuelles et guidées** : l'utilisateur traite **une erreur à la fois**,
en choisissant l'action, depuis la liste des erreurs (`MapAnalysisClient.tsx`). Il n'existe **plus**
d'auto-correction globale en lot (l'ancien endpoint `auto-correct` a été supprimé).

### 5.1 Correction guidée unitaire (`POST /api/analyses/[id]/errors/[errorId]/correct`)

Corps : `{ action, targetNicad? }`. Les corrections sont **cumulatives** (chaque appel repart du dernier `correctedData`).

#### Actions disponibles par type d'erreur

| `errorType` | Actions possibles |
|---|---|
| `INVALID_GEOM` | `delete` (supprime la feature invalide), `ignore` |
| `DUPLICATE` | `delete` (supprime l'occurrence sélectionnée, localisée par sa géométrie), `ignore` |
| `MISSING_NICAD` | `assign_nicad` (NICAD saisi via `targetNicad`, sinon `AUTO_000001` incrémental), `ignore` |
| `OVERLAP` | `clip_first` (découpe `nicad1` par `nicad2`), `clip_second` (inverse), `ignore` |
| `SLIVER` | `merge_neighbor` (rattache à la parcelle adjacente partageant la plus longue frontière commune — `findBestNeighborMerge`), `delete`, `ignore` |
| `GAP` | `assign_to_neighbor` (rattache le gap à `nicad1` ou à `targetNicad` fourni), `ignore` |
| `BOUNDARY_CROSS` | `truncate` (intersection avec la limite administrative), `ignore` |

`ignore` ne modifie pas la géométrie : l'erreur est simplement marquée `corrected = true` (« erreur intentionnelle »).

#### Étapes de traitement

1. Charger l'erreur (`TopologicalError`) et vérifier qu'elle n'est pas déjà `corrected`.
2. Vérifier que l'action demandée est autorisée pour ce `errorType` (table `ACTIONS_BY_TYPE`).
3. Charger le GeoJSON courant : `correctedData ?? fichier disque ?? geoJsonData`.
4. Localiser la/les feature(s) concernée(s) via `findFeatureIndex` (voir ci-dessous).
5. Appliquer l'opération géométrique Turf correspondante (`difference`, `union`, `intersect`).
6. Mettre à jour/supprimer la feature dans le tableau, sérialiser le GeoJSON.
7. **Transaction Prisma** : sauvegarde `Analysis.correctedData` + marque l'erreur `corrected = true` (+ `correctionGeometry` si une nouvelle géométrie a été produite).

#### `findFeatureIndex` — résolution des identifiants de parcelle

```ts
function findFeatureIndex(features, nicad, fallbackGeometry?) {
  // 1) recherche directe par NICAD réel (extractNicad)
  const idx = features.findIndex(f => extractNicad(f.properties) === nicad);
  if (idx !== -1) return idx;

  // 2) identifiant synthétique "feature_N" devenu périmé
  //    (les corrections précédentes ont supprimé des features et décalé les index)
  //    → on retrouve la feature par comparaison de géométrie (tolérance 1e-7)
  if (nicad.startsWith("feature_") && fallbackGeometry) {
    return features.findIndex(f => geometryApproxEqual(f.geometry, fallbackGeometry));
  }
  return -1;
}
```

- Pour les erreurs avec un **vrai NICAD**, la résolution est directe.
- Pour les erreurs créées avec un identifiant **`feature_<idx>`** (parcelle sans NICAD au moment de l'analyse), l'index original peut ne plus correspondre à la bonne feature après plusieurs corrections (suppressions = décalage d'index). Le fallback compare la géométrie stockée dans `TopologicalError.geometry` à celle de chaque feature, avec une tolérance numérique (`1e-7`) car les coordonnées subissent un léger arrondi lors du stockage en `jsonb` PostgreSQL (round-trip).
- Ce fallback est utilisé pour `INVALID_GEOM` (`delete`), `DUPLICATE` (`delete`), `MISSING_NICAD` (`assign_nicad`), `SLIVER` (`merge_neighbor`, `delete`) et `BOUNDARY_CROSS` (`truncate`), où `error.geometry` correspond bien à la géométrie complète de la parcelle visée. Pour `DUPLICATE` et `MISSING_NICAD`, la correspondance géométrique est même la méthode **principale** de localisation (NICAD absent ou ambigu). Pour `OVERLAP`/`GAP`, `error.geometry` représente une intersection/un trou (pas la parcelle elle-même) : le fallback ne s'applique pas dans ces cas.

#### Robustesse géométrique

- `merge_neighbor` (SLIVER) délègue à `findBestNeighborMerge` (`src/lib/sliver-correction.ts`), qui rattache le sliver à la parcelle adjacente partageant la **plus longue frontière commune** (analyse en WGS84, reprojection UTM 28N à la volée). Les features dont la géométrie est invalide/vide (ex. `MultiPolygon` avec `coordinates: []`) sont **ignorées** (`try/catch`) plutôt que de provoquer une erreur 500.

#### Réponses possibles

| Code | Cas |
|---|---|
| `404 "Erreur non trouvée"` | `errorId` inexistant pour cette `analysisId` |
| `400 "Erreur déjà corrigée"` | L'erreur a déjà `corrected = true` |
| `400 "Action invalide pour le type d'erreur ..."` | Action non listée dans `ACTIONS_BY_TYPE` |
| `404 "Parcelle introuvable dans le GeoJSON"` | `findFeatureIndex` n'a trouvé aucune correspondance (ni NICAD ni géométrie) |
| `400 "Fusion/Découpe impossible"` | Échec de l'opération Turf (`union`/`difference`/`intersect` retourne `null`) |
| `200 { success, action, message, correctedGeoJson }` | Succès |

---

## 6. Rapports IA et chat

### 6.1 Rapport d'analyse (`generateAIReport`, `src/lib/geo-engine.ts`)

Généré juste après l'analyse à partir de `AnalysisResult` (statistiques + 5 premières erreurs + tableau des doublons NICAD/OBJECTID). Structure imposée au LLM :
1. Résumé Exécutif
2. Analyse des Erreurs
3. Duplications de données (tableau NICAD | OBJECTIDs | Nb occurrences)
4. Erreurs Prioritaires
5. Score de Conformité
6. Recommandations
7. Conclusion

**Fallback sans LLM** : un rapport Markdown statique est généré directement à partir des stats si `invokeLLM` échoue.

### 6.2 Régénération (`POST /api/analyses/[id]/regenerate-report`)

Recharge le GeoJSON depuis `geojsonKey`, relance `analyzeGeoJSON`, régénère le rapport.

### 6.3 Sauvegarde de rapport (`POST /api/reports`)

Crée une entrée `Report` (type `SUMMARY`/`DETAILED`/`EXPERT`/`CORRECTION`) à partir de `analysis.aiReport`. Export PDF côté client via `src/lib/exportPdf.ts`.

### 6.4 Chat IA (`POST /api/ai/chat`)

Construit un contexte système incluant :
- Statistiques globales de l'analyse (par type/sévérité d'erreur)
- Les 50 premières erreurs (`type | sévérité | nicad | description`)
- Si la question porte sur des mots-clés géo (`superficie`, `voisin`, `parcelle`, ...) : un extrait des 100 premières features du GeoJSON
- Le contexte de la parcelle sélectionnée sur la carte, le cas échéant

Le LLM répond en Markdown, en se basant uniquement sur ces données factuelles.

---

## 7. Récapitulatif des endpoints API principaux

| Méthode & route | Rôle |
|---|---|
| `POST /api/upload-geo` | Parse SHP (zip) ou GeoJSON, reprojection UTM→WGS84 si besoin |
| `POST /api/analyses` | Crée une analyse, lance `analyzeGeoJSON`, stocke les erreurs et le rapport IA |
| `GET /api/analyses` | Liste paginée des analyses + compteurs d'erreurs par type |
| `GET /api/analyses/[id]` | Détail d'une analyse + GeoJSON courant |
| `GET /api/analyses/[id]/errors` | Liste des `TopologicalError` (triées par sévérité) |
| `POST /api/analyses/[id]/errors/[errorId]/correct` | Correction guidée d'une erreur (voir §5.1) |
| `POST /api/analyses/[id]/features` | Modification directe d'une feature dans le GeoJSON stocké |
| `POST /api/analyses/[id]/regenerate-report` | Réanalyse + régénération du rapport IA |
| `GET/POST /api/reports`, `GET /api/reports/[id]` | Gestion des rapports sauvegardés |
| `POST /api/ai/chat` | Chat IA contextualisé |
| `GET /api/admin-boundaries/[level]` | Couches administratives (commune/département/région...) |
| `GET /api/senegal-regions` | Référentiel des régions/communes du Sénégal |
| `GET /api/analyses/stats` | Statistiques agrégées (dashboard) |

---

## 8. Limitations connues

- **Chevauchements** : limités aux 500 premières features, max 200 erreurs retournées.
- **Gaps** : désactivés au-delà de 300 features (coût de l'union progressive).
- **UTM** : seule la zone UTM 28N (Sénégal occidental) est reprojetée automatiquement.
- **`SELF_INTERSECT`** : type défini dans le schéma mais non encore implémenté dans le moteur de détection.
- **Identifiants `feature_<idx>`** : périmés après suppressions successives — résolus par correspondance géométrique approximative (voir §5.1), pour les erreurs dont `geometry` représente la parcelle elle-même (`INVALID_GEOM`, `DUPLICATE`, `MISSING_NICAD`, `SLIVER`, `BOUNDARY_CROSS`).
- **Géométries vides/invalides** (`coordinates: []`) peuvent exister dans un GeoJSON corrigé après plusieurs opérations ; les routines de correction les ignorent silencieusement plutôt que de planter.
- **Fichiers volumineux** : le GeoJSON brut/corrigé est prioritairement lu/écrit sur disque (`uploads/geojson/`), la colonne PostgreSQL `geoJsonData` sert surtout d'historique/fallback.
