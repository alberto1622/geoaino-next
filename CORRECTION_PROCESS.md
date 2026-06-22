# Processus de détection et correction des erreurs cadastrales

## Vue d'ensemble

```
Fichier GeoJSON/SHP
       │
       ▼
  [1] ANALYSE          ← geo-engine.ts → analyzeGeoJSON()
       │
       ▼
  [2] STOCKAGE DB      ← TopologicalError (PostgreSQL)
       │
       ▼
  [3] RAPPORT IA       ← LLM (OpenAI / Groq fallback)
       │
       ▼
  [4] CORRECTION GUIDÉE ← /api/analyses/[id]/errors/[errorId]/correct
       │                   (déclenchée manuellement, erreur par erreur)
       ▼
  GeoJSON corrigé (correctedData)
```

---

## Phase 1 — Détection des erreurs (`analyzeGeoJSON`)

Fichier : `src/lib/geo-engine.ts`

L'analyse est déclenchée à l'upload via `POST /api/analyses`. Elle parcourt toutes les features du GeoJSON en **4 passes séquentielles**.

### Passe 1 — Validité géométrique + NICAD

Pour chaque feature :

| Vérification | Erreur générée | Sévérité |
|---|---|---|
| Géométrie nulle ou coordonnées manquantes | `INVALID_GEOM` | CRITICAL |
| NICAD absent, vide, `"null"`, `"N/A"`, `"0"`, etc. | `MISSING_NICAD` | CRITICAL |
| NICAD présent mais < 8 caractères | `MISSING_NICAD` | CRITICAL |
| Surface quasi nulle ou ratio longueur/largeur > 50 | `SLIVER` | MEDIUM |

**Extraction du NICAD** — la fonction `extractNicad()` cherche le champ dans cet ordre de priorité :
```
nicad → NICAD → Nicad → NIC → NUM_NICAD → num_nicad →
CODE_NICAD → code_nicad → CODIF → codif
```

**Détection sliver** — une parcelle est considérée résiduelle si :
- Surface < 1 m² (coordonnées UTM) ou < 1e-10 (coordonnées géographiques)
- **OU** ratio aspect > 50 (parcelle anormalement longue et fine)

### Passe 2 — Doublons NICAD

Toutes les features valides (NICAD ≥ 8 chars) sont indexées dans une `Map<nicad, indices[]>`. Si un NICAD apparaît plus d'une fois, chaque occurrence génère une erreur :

| Erreur | Sévérité |
|---|---|
| `DUPLICATE` | CRITICAL |

### Passe 3a — Chevauchements (Turf.js)

Limité aux **500 premières features** (performance). Pour chaque paire (i, j) :

1. **Filtre bbox** — si les bounding boxes ne se croisent pas, la paire est ignorée (O(1))
2. **Reprojection UTM→WGS84** si les coordonnées sont en UTM zone 28N (via `proj4`)
3. **`turf.intersect()`** — calcule la géométrie d'intersection réelle
4. Si l'intersection existe et dépasse **0.01 m²** :

| % de chevauchement (sur la plus petite des deux parcelles) | Sévérité |
|---|---|
| > 50 % | CRITICAL |
| 20 – 50 % | HIGH |
| 5 – 20 % | MEDIUM |
| < 5 % | LOW |

Maximum **200 erreurs** de chevauchement retournées par analyse.

### Passe 3b — Espaces vides (Gaps)

Uniquement si le jeu contient entre **3 et 300 features** :

1. Union progressive de toutes les features (`turf.union`)
2. Calcul de l'enveloppe convexe (`turf.convex`)
3. Différence enveloppe − union = zones vides (`turf.difference`)
4. Si le gap > 1 m², les parcelles à moins de 200 m du centroïde du gap sont listées comme adjacentes

| Taille du gap | Sévérité |
|---|---|
| > 100 m² | HIGH |
| ≤ 100 m² | MEDIUM |

### Passe 4 — Dépassement de limite administrative

Si une limite administrative est fournie à l'upload (`adminBoundaryData`) :
- La bounding box de chaque parcelle est comparée à celle de la limite
- Toute parcelle qui dépasse génère une erreur `BOUNDARY_CROSS` (HIGH)

---

## Calcul du score de conformité

```
Pénalité = (erreurs CRITICAL × 10) + (erreurs HIGH × 5) + (erreurs MEDIUM × 2)
Score    = max(0, min(100, 100 − (Pénalité / nb_parcelles) × 10))
```

Le score est arrondi à 1 décimale et stocké dans `Analysis.conformityScore`.

---

## Phase 2 — Stockage en base

Fichier : `src/app/api/analyses/route.ts`

Les erreurs sont insérées par **batches de 100** dans la table `TopologicalError` :

```
TopologicalError {
  analysisId   → lien vers l'analyse
  errorType    → OVERLAP | GAP | SLIVER | DUPLICATE | INVALID_GEOM
                 BOUNDARY_CROSS | MISSING_NICAD | SELF_INTERSECT
  severity     → CRITICAL | HIGH | MEDIUM | LOW
  nicad1       → NICAD de la parcelle principale
  nicad2       → NICAD de la parcelle impliquée (chevauchements)
  description  → message détaillé
  geometry     → GeoJSON de la zone en erreur (pour affichage carte)
  area         → surface en m²
  confidence   → indice de confiance [0.0 – 1.0]
  corrected    → false par défaut
}
```

---

## Phase 3 — Rapport IA

Fichier : `src/lib/geo-engine.ts` → `generateAIReport()`

Un résumé factuel (stats agrégées + 5 premières erreurs) est envoyé au LLM avec la consigne de structurer en 6 sections :

1. Résumé Exécutif
2. Analyse des Erreurs
3. Erreurs Prioritaires
4. Score de Conformité
5. Recommandations
6. Conclusion

**Fallback** : si le LLM échoue, un rapport Markdown statique est généré directement depuis les stats.

---

## Phase 4 — Correction guidée (manuelle, erreur par erreur)

Fichier : `src/app/api/analyses/[id]/errors/[errorId]/correct/route.ts`

> **L'auto-correction globale (« Auto-corriger ») a été retirée.** Chaque correction est désormais
> **déclenchée explicitement par l'utilisateur**, une erreur à la fois, depuis le panneau
> **« Détail de l'erreur »** de la vue carte. Aucune modification n'est appliquée sans action
> de l'utilisateur. Les corrections sont **cumulatives** : chaque appel repart du dernier
> `correctedData` enregistré.

Requête : `POST /api/analyses/[id]/errors/[errorId]/correct` avec `{ action, targetNicad? }`.
Chaque type d'erreur n'autorise que certaines actions (`ACTIONS_BY_TYPE`).

### Actions guidées disponibles

| Erreur | Action(s) | Effet |
|---|---|---|
| `INVALID_GEOM` | `delete` | Supprime la feature à la géométrie invalide |
| `DUPLICATE` | `delete` | Supprime **l'occurrence sélectionnée** du doublon (localisée par sa géométrie) ; les autres parcelles du même NICAD sont conservées |
| `MISSING_NICAD` | `assign_nicad` | Assigne le NICAD saisi par l'utilisateur ; si le champ est vide, génère un `AUTO_000001` incrémental (flag `_autoAssigned`) |
| `OVERLAP` | `clip_first` / `clip_second` | Découpe l'une des deux parcelles (`turf.difference`) pour résoudre le chevauchement |
| `SLIVER` | `merge_neighbor` / `delete` | Rattache à la parcelle adjacente appropriée (voir ci-dessous) ou supprime le sliver |
| `GAP` | `assign_to_neighbor` | Rattache l'espace vide à la parcelle adjacente choisie (`turf.union`) |
| `BOUNDARY_CROSS` | `truncate` | Tronque la parcelle à la limite administrative (`turf.intersect`) |
| *tous* | `ignore` | Marque l'erreur comme intentionnelle, sans modifier la géométrie |

### Rattachement d'un sliver à la parcelle adjacente (`merge_neighbor`)

Fichier : `src/lib/sliver-correction.ts` → `findBestNeighborMerge()`

Sémantique équivalente à l'outil QGIS **« Éliminer les polygones résiduels »**. Pour le sliver sélectionné :

1. **Analyse en WGS84** — toutes les mesures (adjacence, longueur de frontière, surface) sont faites en degrés lon/lat. Les fichiers en **UTM 28N** sont reprojetés à la volée via `proj4` (même convention que `geo-engine.ts`).
2. **Recherche du voisin** parmi les parcelles non-sliver dont la bbox croise celle du sliver :
   - **Priorité 1** — voisin partageant la **plus longue frontière commune** (`turf.lineOverlap`, tolérance 5 m).
   - **Priorité 2** (aucune arête commune détectée) — voisin qui **touche** réellement le sliver (`turf.booleanIntersects`), départagé par la **plus grande surface**.
3. **Fusion** — `turf.union()` du sliver et du voisin, calculée dans les **coordonnées d'origine** pour préserver le CRS source. Le sliver est retiré ; le voisin reçoit la géométrie fusionnée.
4. Si **aucun voisin adjacent** n'est trouvé, l'API renvoie une erreur et le sliver est **conservé tel quel**.

### Résultat

- Le GeoJSON corrigé est sauvegardé dans `Analysis.correctedData` (colonne `TEXT` PostgreSQL)
- L'erreur traitée est marquée `corrected = true` dans `TopologicalError` (avec `correctionGeometry` quand une nouvelle géométrie est produite)
- L'interface met l'erreur à jour en *« Erreur corrigée »* (✓) et affiche le bouton **"Télécharger"** (sans rechargement)

---

## Résumé des types d'erreurs

| Code | Libellé | Sévérité par défaut | Correction guidée (UI) |
|---|---|---|---|
| `INVALID_GEOM` | Géométrie invalide ou nulle | CRITICAL | ✅ Suppression |
| `MISSING_NICAD` | NICAD absent ou trop court | CRITICAL | ✅ Assignation NICAD (saisie ou AUTO) |
| `DUPLICATE` | NICAD dupliqué | CRITICAL | ✅ Suppression de l'occurrence |
| `OVERLAP` | Chevauchement entre parcelles | LOW → CRITICAL | ✅ Découpe |
| `GAP` | Espace vide entre parcelles | MEDIUM / HIGH | ✅ Comblement vers voisin |
| `SLIVER` | Parcelle résiduelle | MEDIUM | ✅ Rattachement voisin / suppression |
| `BOUNDARY_CROSS` | Dépassement limite administrative | HIGH | ✅ Troncature |
| `SELF_INTERSECT` | Auto-intersection de géométrie | — | ❌ Non détecté |

> Toutes les corrections sont **manuelles** : l'utilisateur choisit l'action pour chaque erreur. Aucune correction n'est appliquée automatiquement en lot.

---

## Limitations connues

- **Chevauchements** : limités aux 500 premières features, max 200 erreurs retournées
- **Gaps** : désactivés au-delà de 300 features (coût de l'union progressive)
- **UTM** : seul le fuseau UTM 28N (Sénégal occidental) est reprojeté automatiquement
- **SELF_INTERSECT** : le type est défini dans le schéma mais pas encore implémenté dans le moteur
- **Fichiers volumineux** : le GeoJSON brut est stocké en colonne `TEXT` PostgreSQL et en fichier local (`uploads/geojson/`) — la colonne est prioritaire pour les lectures
