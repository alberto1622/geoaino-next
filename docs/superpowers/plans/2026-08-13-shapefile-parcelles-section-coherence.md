# Mappage 9 champs + vérification de cohérence de section (shapefile page d'accueil) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Élargir le mappage de champs du chemin shapefile page d'accueil (`job.kind === "parcelles"`) de 2 à 9 champs (region, departement, commune, quartier, numLot, superficie, codeSection, en plus de nicad/numParcelle déjà en place), enrichir CHAQUE parcelle avec ces champs sous des clés canoniques, et vérifier — pour chaque parcelle, indépendamment de son statut NICAD — que la section déclarée (`codeSection` mappé depuis le `.dbf`) correspond à la section trouvée par jointure spatiale sur `limite_section` ; en cas de désaccord, ne PAS construire/modifier le NICAD et lever une nouvelle erreur d'analyse persistée (`section_mismatch`) proposant la section géolocalisée comme correction.

**Architecture:** `assignSectionNicad` (`src/lib/cadastre/assign-section-nicad.ts`) est refactoré pour (1) copier les 7 nouveaux champs mappés sous leurs clés canoniques dans `properties`, pour TOUTE feature, et (2) élargir son ensemble de candidats à la résolution spatiale à TOUTES les features avec un point représentatif (plus seulement celles sans NICAD valide), afin d'écrire aussi une clé canonique `sectionGeolocalisee` (11 chiffres syscol+section) pour toute parcelle résolue. La construction du NICAD elle-même reste inchangée dans son principe (jamais reconstruit si déjà valide). La détection de l'incohérence elle-même est déléguée à `analyzeGeoJSON` (`geo-engine.ts`), qui lit les deux clés canoniques (`codeSection` déclaré, `sectionGeolocalisee` trouvé) dans sa boucle existante par feature, suivant exactement le même motif que sa détection actuelle de `missing_nicad` — et pousse une nouvelle entrée d'erreur `section_mismatch`, persistée comme toute autre erreur topologique (nécessite une valeur d'enum Prisma `ErrorType` supplémentaire).

**Tech Stack:** Next.js App Router, TypeScript strict, Prisma/PostGIS, React (`"use client"`), pas de framework de test (vérification = `npx tsc --noEmit -p .` + `npx eslint <fichiers>`). Aucune base de données réelle disponible dans l'environnement d'implémentation — la migration Prisma ne peut être qu'écrite/vérifiée en format, jamais exécutée (`prisma migrate deploy` reste une étape manuelle utilisateur).

## Global Constraints

- Ne modifie QUE le chemin page d'accueil (`job.kind === "parcelles"`) pour la logique métier — `/cadastre/import` et `SectionsClient` ne sont pas touchés. Les fichiers partagés (`geo-engine.ts`, `nicad.ts`, le schéma Prisma, les composants carte) SONT modifiés car la détection d'erreur et l'affichage sont des mécanismes génériques déjà partagés par tous les chemins d'analyse.
- Ne JAMAIS reconstruire un NICAD déjà valide (contrainte héritée, inchangée).
- En cas de désaccord section déclarée / section géolocalisée pour une parcelle SANS NICAD valide : ne pas construire de NICAD pour cette parcelle (aucune des deux valeurs de section n'est utilisée pour `buildNicad` — la parcelle reste dans l'état `nbSansNumeroParcelle`/non traité, l'erreur `section_mismatch` porte l'information à corriger manuellement). Ceci est une décision explicite de l'utilisateur (la section géolocalisée NE fait PAS autorité automatiquement).
- La vérification de cohérence de section s'applique à TOUTES les parcelles résolues spatialement, y compris celles ayant déjà un NICAD valide (décision explicite de l'utilisateur — détecte aussi les erreurs sur des parcelles déjà NICADées).
- Les 7 nouveaux champs mappés sont écrits sous forme de propriétés canoniques dans le GeoJSON (en plus des colonnes `.dbf` brutes conservées telles quelles), symétrique du traitement déjà en place pour `nicad`/`numParcelle`.
- Aucun champ du nouveau mappage n'est `required: true` — un shapefile sans mappage pour un champ donné continue de fonctionner (ce champ n'est simplement pas enrichi/vérifié pour cette parcelle).

---

## File Structure

- `src/lib/import/field-mapping.ts` — **modifier** : `PARCELLES_HOME_TARGET_FIELDS` passe de 2 à 9 entrées (réutilise les définitions déjà existantes de `PARCELLE_TARGET_FIELDS` pour les 7 nouvelles).
- `src/lib/nicad.ts` — **modifier** : ajoute `digitsOnly()` et `codeSectionsMatch()`, réutilisables par `assign-section-nicad.ts` (comptage job) et `geo-engine.ts` (détection d'erreur persistée).
- `prisma/schema.prisma` — **modifier** : ajoute `SECTION_MISMATCH` à `enum ErrorType`.
- `prisma/migrations/20260813090000_add_section_mismatch_error_type/migration.sql` — **créer** : migration hand-authored (pas de DB live disponible), suit exactement le format de la migration précédente `20260624000000_add_short_nicad_error_type`.
- `src/lib/geo-engine.ts` — **modifier** : `analyzeGeoJSON` détecte l'incohérence de section (clés canoniques `codeSection`/`sectionGeolocalisee`) dans sa boucle par-feature existante, pousse une erreur `section_mismatch`.
- `src/lib/cadastre/assign-section-nicad.ts` — **modifier en profondeur** : enrichissement des 7 champs canoniques pour toute feature, résolution spatiale élargie à toute feature (pas seulement sans NICAD), écriture de `sectionGeolocalisee`, nouveau compteur `nbIncoherenceSection`.
- `src/lib/import/run-job.ts` — **modifier** : union locale `ErrType` gagne `"SECTION_MISMATCH"`.
- `src/lib/import/run-shapefile-job.ts` — **modifier** : le littéral de repli `sectionNicad` (catch d'échec d'`assignSectionNicad`) gagne `nbIncoherenceSection: 0` ; `reportExtra` transmet aussi `nbIncoherenceSection`.
- `src/lib/utils.ts` — **modifier** : `errorTypeColor()` gagne un `case "section_mismatch"`.
- `src/components/MapLibreMap.tsx` — **modifier** : `ERROR_TYPE_LABELS` gagne `section_mismatch: "Incohérence de section"`.
- `src/components/LeafletMap.tsx` — **modifier** : `ERROR_COLORS` gagne `SECTION_MISMATCH`.
- `docs/CONCEPTS-TRAITEMENT-DXF.md` — **modifier** : nouvelle section `## 19.` (mandatée par CLAUDE.md).
- `docs/README.md` — **modifier** : référence la nouvelle section 19.

---

### Task 1: Mappage 9 champs (field-mapping.ts)

**Files:**
- Modify: `src/lib/import/field-mapping.ts:41-62` (`PARCELLES_HOME_TARGET_FIELDS` et son commentaire JSDoc)

**Interfaces:**
- Consumes: rien de nouveau — `TargetFieldDef` déjà défini dans ce fichier.
- Produces: `PARCELLES_HOME_TARGET_FIELDS` (9 entrées : `nicad`, `numParcelle`, `region`, `departement`, `commune`, `quartier`, `numLot`, `superficie`, `codeSection`) — consommé par `FieldMappingModal` (via `targetFieldsFor("parcelles-home")`, inchangé) et par `assign-section-nicad.ts` (Task 5, via les clés `fieldMapping.region`/`.departement`/`.commune`/`.quartier`/`.numLot`/`.superficie`/`.codeSection`/`.nicad`/`.numParcelle`).

- [ ] **Step 1: Remplacer `PARCELLES_HOME_TARGET_FIELDS` et son commentaire**

Remplacer le bloc actuel (lignes 41-62) :
```ts
/**
 * Cibles de mappage pour le chemin shapefile de la page d'accueil
 * (job.kind === "parcelles" → Analysis.geoJsonData). Contrairement à
 * PARCELLE_TARGET_FIELDS (15 champs, colonnes DB typées de cad_parcelles),
 * ce chemin conserve TOUTES les propriétés .dbf telles quelles dans le
 * GeoJSON — seuls nicad et numParcelle sont mappés ici, car ce sont les 2
 * seuls champs dont dépend la construction automatique du NICAD
 * (assignSectionNicad, section-join). `numParcelle` reprend exactement les
 * alias de NUM_PARCELLE_ALIASES (assign-section-nicad.ts) — aucune perte de
 * couverture par rapport au devinage actuel. `nicad` reprend les variantes
 * reconnues par `extractNicad` (geo-engine.ts) — la comparaison ci-dessous
 * (proposeFieldMapping) étant insensible à la casse, seules les variantes
 * lexicalement distinctes une fois en minuscules sont listées.
 */
export const PARCELLES_HOME_TARGET_FIELDS: TargetFieldDef[] = [
  {
    key: "nicad",
    label: "NICAD (16 caractères)",
    aliases: ["nicad", "nic", "num_nicad", "code_nicad", "codif"],
  },
  { key: "numParcelle", label: "N° de parcelle", aliases: ["numparcell", "num_parce", "numparce", "numparcelle"] },
];
```
par :
```ts
/**
 * Cibles de mappage pour le chemin shapefile de la page d'accueil
 * (job.kind === "parcelles" → Analysis.geoJsonData). Contrairement à
 * PARCELLE_TARGET_FIELDS (15 champs, colonnes DB typées de cad_parcelles),
 * ce chemin conserve TOUTES les propriétés .dbf telles quelles dans le
 * GeoJSON — les 9 champs ci-dessous sont EN PLUS copiés sous leurs clés
 * canoniques dans les propriétés (cf. `assignSectionNicad`,
 * `enrichCanonicalFields`), sans supprimer les colonnes .dbf brutes.
 *
 * `nicad`/`numParcelle` gardent leur rôle historique (devinage par alias en
 * repli, construction du NICAD). Les 7 autres (region, departement, commune,
 * quartier, numLot, superficie, codeSection) reprennent VERBATIM les
 * définitions de PARCELLE_TARGET_FIELDS (mêmes clés/alias) — aucune
 * divergence de couverture entre les deux chemins d'import shapefile.
 * `codeSection` (11 chiffres, syscol+section) alimente la vérification de
 * cohérence de section : comparé à `sectionGeolocalisee` (trouvé par
 * jointure spatiale) dans `analyzeGeoJSON` (geo-engine.ts) — désaccord =
 * nouvelle erreur d'analyse `section_mismatch`.
 */
export const PARCELLES_HOME_TARGET_FIELDS: TargetFieldDef[] = [
  {
    key: "nicad",
    label: "NICAD (16 caractères)",
    aliases: ["nicad", "nic", "num_nicad", "code_nicad", "codif"],
  },
  { key: "numParcelle", label: "N° de parcelle", aliases: ["numparcell", "num_parce", "numparce", "numparcelle"] },
  { key: "region", label: "Région", aliases: ["region"] },
  { key: "departement", label: "Département", aliases: ["departemen", "departement"] },
  { key: "commune", label: "Commune", aliases: ["commune", "nomcommune", "nom_commun", "nom"] },
  { key: "quartier", label: "Quartier", aliases: ["quartier", "nom_quart"] },
  { key: "numLot", label: "N° de lot", aliases: ["numlot", "num_lot"] },
  { key: "superficie", label: "Superficie", aliases: ["suplegale", "supreelle", "superficie", "shape_area"] },
  { key: "codeSection", label: "Code section (11 chiffres, syscol+section)", aliases: ["codesectio", "cod_sect"] },
];
```

- [ ] **Step 2: Vérifier**

Run: `npx tsc --noEmit -p .` — seules les 2 erreurs `RouteContext` de référence (si présentes dans l'environnement) sont acceptables.
Run: `npx eslint src/lib/import/field-mapping.ts` — 0 erreur/warning.

- [ ] **Step 3: Commit**

```bash
git add src/lib/import/field-mapping.ts
git commit -m "feat(import): expand parcelles-home field-mapping to 9 targets (region/departement/commune/quartier/numLot/superficie/codeSection)"
```

---

### Task 2: Helpers de comparaison de section (nicad.ts)

**Files:**
- Modify: `src/lib/nicad.ts` — insérer après la fonction `normalizeSection` (après sa fermeture, avant `export interface NicadPrefixResult`)

**Interfaces:**
- Consumes: `NICAD_SECTION_LENGTH` (déjà défini dans ce fichier, ligne 19).
- Produces: `digitsOnly(raw: string | null | undefined): string` et `codeSectionsMatch(declaredRaw: string | null | undefined, geolocatedRaw: string | null | undefined): boolean | null` — consommés par `assign-section-nicad.ts` (Task 5) et `geo-engine.ts` (Task 4).

- [ ] **Step 1: Ajouter les deux fonctions**

Insérer, juste après la fermeture de `normalizeSection` (ligne 57 actuelle : `}`) et avant `export interface NicadPrefixResult` :
```ts

/** Extrait uniquement les chiffres d'une chaîne (normalisation avant comparaison). */
export function digitsOnly(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Compare un codeSection déclaré (`.dbf`, longueur variable — parfois
 * seulement le numéro de section à 3 chiffres, parfois le code complet à
 * 11 chiffres syscol+section) à un codeSection géolocalisé (toujours 11
 * chiffres, `syscolCommune` + `numSection` concaténés par jointure
 * spatiale). Si le déclaré ne compte que 3 chiffres, la comparaison porte
 * uniquement sur les 3 derniers chiffres du géolocalisé (le numéro de
 * section) — évite un faux mismatch systématique sur les fichiers qui ne
 * saisissent pas le préfixe syscol. Renvoie `null` si l'un des deux côtés
 * est vide/non exploitable (rien à comparer, pas d'erreur à lever).
 */
export function codeSectionsMatch(
  declaredRaw: string | null | undefined,
  geolocatedRaw: string | null | undefined,
): boolean | null {
  const declared = digitsOnly(declaredRaw);
  const geolocated = digitsOnly(geolocatedRaw);
  if (!declared || !geolocated) return null;
  if (declared.length === NICAD_SECTION_LENGTH) {
    return declared === geolocated.slice(-NICAD_SECTION_LENGTH);
  }
  return declared === geolocated;
}
```

- [ ] **Step 2: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/lib/nicad.ts` — aucune nouvelle erreur/warning.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nicad.ts
git commit -m "feat(nicad): add digitsOnly/codeSectionsMatch helpers for section-coherence comparison"
```

---

### Task 3: Enum Prisma SECTION_MISMATCH + migration

**Files:**
- Modify: `prisma/schema.prisma:133-143` (`enum ErrorType`)
- Create: `prisma/migrations/20260813090000_add_section_mismatch_error_type/migration.sql`

**Interfaces:**
- Consumes: rien.
- Produces: la valeur `SECTION_MISMATCH` de l'enum Prisma `ErrorType`, utilisée par `run-job.ts` (Task 6, `errorType: e.type.toUpperCase() as ErrType` avec le nouveau type `"section_mismatch"` produit par Task 4) lors de la persistance des erreurs topologiques.

**IMPORTANT :** aucune base de données réelle n'est disponible dans cet environnement d'implémentation. NE PAS tenter d'exécuter `prisma migrate dev`, `prisma migrate deploy`, `prisma db push`, ou toute commande se connectant à une base — aucune ne réussira ici. La migration doit être écrite à la main, au format exact de la migration précédente (`prisma/migrations/20260624000000_add_short_nicad_error_type/migration.sql`), et sera appliquée manuellement par l'utilisateur plus tard.

- [ ] **Step 1: Étendre l'enum dans schema.prisma**

Remplacer (lignes 133-143) :
```prisma
enum ErrorType {
  OVERLAP
  GAP
  SLIVER
  DUPLICATE
  INVALID_GEOM
  BOUNDARY_CROSS
  MISSING_NICAD
  SHORT_NICAD
  SELF_INTERSECT
}
```
par :
```prisma
enum ErrorType {
  OVERLAP
  GAP
  SLIVER
  DUPLICATE
  INVALID_GEOM
  BOUNDARY_CROSS
  MISSING_NICAD
  SHORT_NICAD
  SELF_INTERSECT
  SECTION_MISMATCH
}
```

- [ ] **Step 2: Créer la migration**

Créer le dossier `prisma/migrations/20260813090000_add_section_mismatch_error_type/` avec le fichier `migration.sql` :
```sql
-- Ajoute la valeur SECTION_MISMATCH à l'enum ErrorType.
-- (Section déclarée dans le fichier source ≠ section trouvée par jointure
-- spatiale sur limite_section — cf. analyzeGeoJSON, geo-engine.ts.)
ALTER TYPE "ErrorType" ADD VALUE IF NOT EXISTS 'SECTION_MISMATCH';
```

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit -p .` — le changement de schéma seul ne doit provoquer aucune nouvelle erreur TypeScript à ce stade (le client Prisma généré n'est pas régénéré dans cet environnement ; ceci sera cohérent une fois la migration appliquée et `prisma generate` exécuté par l'utilisateur). Ne PAS lancer `npx prisma generate` ni `npx prisma migrate` dans cet environnement.
Vérifier manuellement (lecture) que le fichier `migration.sql` créé est syntaxiquement identique en structure à `prisma/migrations/20260624000000_add_short_nicad_error_type/migration.sql`, seule la valeur diffère.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260813090000_add_section_mismatch_error_type/
git commit -m "feat(db): add SECTION_MISMATCH to ErrorType enum (hand-authored migration, no live DB in this environment)"
```

---

### Task 4: Détection section_mismatch (geo-engine.ts)

**Files:**
- Modify: `src/lib/geo-engine.ts` — import en tête de fichier + insertion dans la boucle `features.forEach` existante de `analyzeGeoJSON`

**Interfaces:**
- Consumes: `codeSectionsMatch`, `digitsOnly` (Task 2, `@/lib/nicad` — attention, geo-engine.ts est dans `src/lib/`, donc l'import relatif est `./nicad`).
- Produces: un nouveau type d'erreur `"section_mismatch"` (chaîne, `AnalysisResult.errors[].type` est déjà typé `string` en général — aucun changement de type nécessaire sur l'interface `AnalysisResult`) — consommé par `run-job.ts` (Task 6, persistance via `e.type.toUpperCase() as ErrType` → `"SECTION_MISMATCH"`, Task 3) et par les composants carte (Task 7).

- [ ] **Step 1: Ajouter l'import**

En tête de `src/lib/geo-engine.ts`, après la ligne `import { BBoxGridIndex, bboxIntersects, type BBox } from "./parcelle-ingestion";` (ligne 3), ajouter :
```ts
import { codeSectionsMatch, digitsOnly } from "./nicad";
```

- [ ] **Step 2: Ajouter la détection dans la boucle `features.forEach`**

Dans `analyzeGeoJSON`, la boucle `features.forEach((f, idx) => { ... })` contient un bloc de détection sliver qui se termine ainsi (lignes 229-247 actuelles) :
```ts
    const coords = getPolygonCoords(f);
    if (coords && coords.length >= 3) {
      const { isSliver, area, aspectRatio } = detectSliver(f);
      surfaces.push(area);
      totalSurface += area;

      if (isSliver) {
        nonConformeIdx.add(idx);
        errors.push({
          type: "sliver",
          severity: "medium",
          nicad1: nicad || `feature_${idx}`,
          description: `Parcelle résiduelle (sliver) détectée: surface=${area.toFixed(6)}, ratio=${aspectRatio.toFixed(1)}`,
          area,
          confidence: 0.9,
          geometry: f.geometry,
        });
      }
    }
  });
```
Insérer un nouveau bloc juste avant le `});` final de la boucle (donc entre la fermeture du `if (coords && coords.length >= 3) {` et le `});` qui ferme `features.forEach`) :
```ts
    const coords = getPolygonCoords(f);
    if (coords && coords.length >= 3) {
      const { isSliver, area, aspectRatio } = detectSliver(f);
      surfaces.push(area);
      totalSurface += area;

      if (isSliver) {
        nonConformeIdx.add(idx);
        errors.push({
          type: "sliver",
          severity: "medium",
          nicad1: nicad || `feature_${idx}`,
          description: `Parcelle résiduelle (sliver) détectée: surface=${area.toFixed(6)}, ratio=${aspectRatio.toFixed(1)}`,
          area,
          confidence: 0.9,
          geometry: f.geometry,
        });
      }
    }

    const declaredCodeSection = props.codeSection as string | undefined;
    const geolocatedCodeSection = props.sectionGeolocalisee as string | undefined;
    if (codeSectionsMatch(declaredCodeSection, geolocatedCodeSection) === false) {
      nonConformeIdx.add(idx);
      errors.push({
        type: "section_mismatch",
        severity: "high",
        nicad1: nicad || `feature_${idx}`,
        description:
          `Section déclarée (${digitsOnly(declaredCodeSection)}) différente de la section trouvée ` +
          `par géolocalisation (${digitsOnly(geolocatedCodeSection)}) — correction proposée : ` +
          `attribuer la section géolocalisée.`,
        confidence: 0.9,
        geometry: f.geometry,
      });
    }
  });
```
(`props` et `nicad` sont déjà des variables en portée dans cette boucle, définies en tête de l'itération — ne pas les redéclarer.)

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/lib/geo-engine.ts` — aucune nouvelle erreur/warning.

- [ ] **Step 4: Commit**

```bash
git add src/lib/geo-engine.ts
git commit -m "feat(geo-engine): detect section_mismatch (declared codeSection vs geolocated section)"
```

---

### Task 5: Refactor assignSectionNicad (enrichissement + périmètre élargi + compteur)

**Files:**
- Modify: `src/lib/cadastre/assign-section-nicad.ts` (remplacement quasi complet du fichier)

**Interfaces:**
- Consumes: `codeSectionsMatch` (Task 2, `@/lib/nicad`), `FieldMapping` (déjà importé), `getSectionsForPoints` (inchangé, `./sections-data`).
- Produces: `assignSectionNicad(features, fieldMapping?): Promise<{ nbConstruits, nbSansSection, nbSansNumeroParcelle, nbIncoherenceSection, warnings }>` — signature de retour élargie d'un champ (`nbIncoherenceSection`) par rapport à l'existant. Écrit, pour toute feature résolue spatialement, la clé canonique `sectionGeolocalisee` dans `properties` — consommée par `geo-engine.ts` (Task 4, déjà fait). Écrit aussi, pour toute feature avec un mappage exploitable, les clés canoniques `region`/`departement`/`commune`/`quartier`/`numLot`/`superficie`/`codeSection`.
- **Cette tâche DOIT être suivie immédiatement par Task 6** (qui met à jour le seul appelant, `run-shapefile-job.ts`, et l'union locale `ErrType` de `run-job.ts`) — le littéral de repli dans `run-shapefile-job.ts` référence les 4 champs de comptage nommément et cesse de type-checker tant que Task 6 n'est pas appliquée. Ne pas s'arrêter à une vérification `tsc` propre en isolation après cette seule tâche — l'erreur attendue dans `run-shapefile-job.ts` (champ `nbIncoherenceSection` manquant) est normale à ce stade intermédiaire et sera résolue par Task 6.

- [ ] **Step 1: Remplacer le contenu complet du fichier**

Remplacer l'intégralité de `src/lib/cadastre/assign-section-nicad.ts` par :
```ts
/**
 * assign-section-nicad.ts — enrichissement + construction du NICAD des
 * parcelles shapefile (chemin page d'accueil → `Analysis`,
 * `job.kind === "parcelles"`) par jointure spatiale sur `limite_section`.
 *
 * Deux responsabilités, appliquées en une seule passe de résolution
 * spatiale :
 *
 *   1. Enrichissement : copie, pour CHAQUE feature (indépendamment de son
 *      statut NICAD), les champs mappés par l'utilisateur
 *      (FieldMappingModal, `PARCELLES_HOME_TARGET_FIELDS`) sous leurs clés
 *      canoniques dans les propriétés — region, departement, commune,
 *      quartier, numLot, superficie, codeSection — plus `sectionGeolocalisee`
 *      (codeSection à 11 chiffres syscol+section trouvé par jointure
 *      spatiale, quel que soit le statut NICAD de la feature). Ces clés
 *      canoniques sont lues telles quelles par `analyzeGeoJSON`
 *      (`geo-engine.ts`) pour détecter les incohérences de section
 *      (`section_mismatch`), sans dépendre du mappage d'origine.
 *
 *   2. Construction NICAD : symétrique de `assign-nicad-2026.ts` (jointure
 *      commune pour le DXF) mais résolvant Syscol ET section en une seule
 *      requête, `limite_section` portant les deux. Ne reconstruit JAMAIS un
 *      NICAD déjà valide (16 chiffres, format correct) — ne comble que les
 *      trous. N'attribue jamais de numéro de parcelle par incrémentation :
 *      si aucun numéro exploitable n'est dans les propriétés `.dbf` de la
 *      parcelle, son NICAD reste non construit (cf. `fillMissingNicadForSection`,
 *      ailleurs, pour l'attribution après coup). En cas d'incohérence de
 *      section (déclarée ≠ géolocalisée), le NICAD n'est PAS construit pour
 *      les parcelles qui n'en ont pas déjà un valide — aucune des deux
 *      valeurs de section ne fait autorité automatiquement (décision
 *      produit : l'incohérence doit être résolue manuellement).
 */
import * as turf from "@turf/turf";
import { getSectionsForPoints } from "./sections-data";
import { extractNicad } from "@/lib/geo-engine";
import { validateNicadFormat } from "./nicad-logic";
import type { FieldMapping } from "@/lib/import/field-mapping";
import { buildNicad, normalizeNumeroParcelle, codeSectionsMatch } from "@/lib/nicad";

const NUM_PARCELLE_ALIASES = ["numparcell", "num_parce", "numparce", "numparcelle"];

/** Champs canoniques enrichis depuis le mappage pour TOUTE feature, indépendamment
 *  du statut NICAD — cf. §1 du commentaire d'en-tête. `nicad`/`numParcelle` ont
 *  leur propre gestion dédiée (lecture avec priorité, construction) plus bas. */
const CANONICAL_ENRICHMENT_FIELDS = [
  "region", "departement", "commune", "quartier", "numLot", "superficie", "codeSection",
] as const;

/**
 * Extrait le numéro de parcelle des propriétés `.dbf` d'une feature, via les
 * mêmes alias que `PARCELLE_TARGET_FIELDS.numParcelle` (`field-mapping.ts`).
 *
 * Comparaison de clé INSENSIBLE À LA CASSE (`k.toLowerCase() === alias`),
 * délibérément différente du style « variantes de casse explicites » de
 * `extractNicad` (`geo-engine.ts`) : ce dernier énumère un NICAD/alias déjà
 * connu et peu nombreux à la casse prévisible. Ici, la casse réelle des
 * colonnes `.dbf` est imprévisible (Esri tronque/majuscule souvent à 10
 * caractères) — c'est exactement le problème déjà résolu par `propByAlias`
 * dans `sections-from-shapefile.ts`, dont ce helper reprend le style pour
 * rester cohérent avec le code qui traite le MÊME espace de données
 * (attributs `.dbf` de shapefile, alias `field-mapping.ts`), plutôt qu'avec
 * `extractNicad` qui traite un problème différent (une seule propriété
 * canonique connue sous quelques variantes fixes).
 *
 * `mappedColumn` (colonne mappée explicitement par l'utilisateur via
 * FieldMappingModal) est prioritaire sur ce devinage par alias : une
 * correspondance validée par l'utilisateur ne doit jamais être contournée
 * par une correspondance fortuite avec un alias générique.
 */
function extractNumParcelle(
  props: Record<string, unknown> | undefined | null,
  mappedColumn?: string,
): string | null {
  if (!props) return null;

  if (mappedColumn) {
    const raw = Object.prototype.hasOwnProperty.call(props, mappedColumn) ? props[mappedColumn] : undefined;
    if (raw != null && String(raw).trim()) {
      return normalizeNumeroParcelle(String(raw)).value;
    }
    return null;
  }

  for (const alias of NUM_PARCELLE_ALIASES) {
    const hit = Object.entries(props).find(([k]) => k.toLowerCase() === alias);
    if (hit && hit[1] != null && String(hit[1]).trim()) {
      return normalizeNumeroParcelle(String(hit[1])).value;
    }
  }
  return null;
}

function representativePoint(geometry: GeoJSON.Feature["geometry"]): [number, number] | null {
  if (!geometry) return null;
  try {
    return turf.pointOnFeature(turf.feature(geometry)).geometry.coordinates as [number, number];
  } catch {
    return null;
  }
}

/**
 * Copie, pour une feature donnée, les champs mappés par l'utilisateur
 * (hors nicad/numParcelle, gérés séparément) sous leurs clés canoniques
 * dans les propriétés. Mute `feature.properties` UNIQUEMENT si au moins un
 * champ a effectivement été copié (évite une réallocation d'objet inutile
 * pour les features sans mappage exploitable).
 */
function enrichCanonicalFields(feature: GeoJSON.Feature, fieldMapping: FieldMapping): void {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  let enriched: Record<string, unknown> | null = null;
  for (const key of CANONICAL_ENRICHMENT_FIELDS) {
    const col = fieldMapping[key];
    if (!col || !Object.prototype.hasOwnProperty.call(props, col)) continue;
    const raw = props[col];
    if (raw == null || String(raw).trim() === "") continue;
    if (!enriched) enriched = { ...props };
    enriched[key] = raw;
  }
  if (enriched) feature.properties = enriched;
}

/**
 * Mute en place TOUTES les features : enrichit leurs champs canoniques
 * (région, département, commune, quartier, n° de lot, superficie, section
 * déclarée, section géolocalisée), et construit le NICAD des features qui
 * n'en ont pas déjà un valide et dont la section ne présente pas
 * d'incohérence. Renvoie un rapport de comptage/avertissements pour le
 * résumé de job (les incohérences de section elles-mêmes sont détectées
 * séparément par `analyzeGeoJSON`, qui lit les mêmes clés canoniques pour
 * produire une erreur `section_mismatch` persistée par parcelle).
 */
export async function assignSectionNicad(
  features: GeoJSON.Feature[],
  fieldMapping?: FieldMapping,
): Promise<{
  nbConstruits: number;
  nbSansSection: number;
  nbSansNumeroParcelle: number;
  nbIncoherenceSection: number;
  warnings: string[];
}> {
  let nbConstruits = 0;
  let nbSansSection = 0;
  let nbSansNumeroParcelle = 0;
  let nbIncoherenceSection = 0;
  const warnings: string[] = [];

  // ── Enrichissement des champs canoniques : s'applique à TOUTES les
  // features, indépendamment de leur statut NICAD. ───────────────────────
  if (fieldMapping) {
    for (const feature of features) {
      enrichCanonicalFields(feature, fieldMapping);
    }
  }

  // ── Détermine, pour chaque feature avec un point représentatif
  // résolvable, si elle a déjà un NICAD valide. La résolution spatiale
  // s'applique à TOUTES ces features (pas seulement celles sans NICAD) —
  // nécessaire pour écrire `sectionGeolocalisee` même sur les parcelles
  // déjà NICADées, condition de la vérification de cohérence de section. ──
  const candidates: { index: number; point: [number, number]; hasValidNicad: boolean }[] = [];
  for (let i = 0; i < features.length; i++) {
    const props = (features[i].properties ?? {}) as Record<string, unknown>;
    const mappedNicadRaw = fieldMapping?.nicad && Object.prototype.hasOwnProperty.call(props, fieldMapping.nicad)
      ? props[fieldMapping.nicad]
      : undefined;
    const existing = mappedNicadRaw != null && String(mappedNicadRaw).trim()
      ? String(mappedNicadRaw).trim()
      : extractNicad(props);
    const hasValidNicad = !!existing && validateNicadFormat(existing).valid;
    if (hasValidNicad && props.nicad !== existing) {
      features[i].properties = { ...props, nicad: existing };
    }

    const point = representativePoint(features[i].geometry);
    if (!point) continue;
    candidates.push({ index: i, point, hasValidNicad });
  }

  if (candidates.length === 0) {
    return { nbConstruits, nbSansSection, nbSansNumeroParcelle, nbIncoherenceSection, warnings };
  }

  const matches = await getSectionsForPoints(candidates.map((c) => ({ lng: c.point[0], lat: c.point[1] })));

  let nbApprox = 0;
  candidates.forEach((c, k) => {
    const m = matches[k];
    const props = (features[c.index].properties ?? {}) as Record<string, unknown>;

    if (!m.syscolCommune || !m.numSection) {
      if (!c.hasValidNicad) nbSansSection++;
      return;
    }
    if (m.approx && !c.hasValidNicad) nbApprox++;

    const sectionGeolocalisee = `${m.syscolCommune}${m.numSection}`;
    let currentProps = props;
    if (currentProps.sectionGeolocalisee !== sectionGeolocalisee) {
      currentProps = { ...currentProps, sectionGeolocalisee };
      features[c.index].properties = currentProps;
    }

    const sectionsMatch = codeSectionsMatch(currentProps.codeSection as string | undefined, sectionGeolocalisee);
    if (sectionsMatch === false) {
      nbIncoherenceSection++;
    }

    if (c.hasValidNicad) return; // NICAD déjà valide : jamais reconstruit.
    if (sectionsMatch === false) return; // Incohérence : aucune section ne fait autorité automatiquement.

    const numParcelle = extractNumParcelle(currentProps, fieldMapping?.numParcelle);
    if (!numParcelle) {
      nbSansNumeroParcelle++;
      return;
    }

    const nicad = buildNicad(m.syscolCommune, m.numSection, numParcelle);
    if (nicad) {
      features[c.index].properties = { ...currentProps, nicad };
      nbConstruits++;
    }
  });

  if (nbApprox > 0) {
    warnings.push(
      `${nbApprox} parcelle(s) rattachée(s) à une section par proximité ` +
        "(point hors contenance stricte, ≤ 50 m d'une limite) — NICAD à vérifier.",
    );
  }
  if (nbSansSection > 0) {
    warnings.push(
      `${nbSansSection} parcelle(s) sans section correspondante dans limite_section ` +
        "(hors emprise du référentiel) — NICAD non construit.",
    );
  }
  if (nbSansNumeroParcelle > 0) {
    warnings.push(
      `${nbSansNumeroParcelle} parcelle(s) rattachée(s) à une section mais sans numéro de ` +
        "parcelle exploitable dans le fichier source — NICAD non construit.",
    );
  }
  if (nbIncoherenceSection > 0) {
    warnings.push(
      `${nbIncoherenceSection} parcelle(s) dont la section déclarée dans le fichier diffère de ` +
        "la section trouvée par géolocalisation — vérifier l'attribution (voir les erreurs " +
        "d'analyse « Incohérence de section »).",
    );
  }

  return { nbConstruits, nbSansSection, nbSansNumeroParcelle, nbIncoherenceSection, warnings };
}
```

- [ ] **Step 2: Vérifier (partiel — l'erreur dans run-shapefile-job.ts est attendue à ce stade)**

Run: `npx eslint src/lib/cadastre/assign-section-nicad.ts` — 0 erreur/warning sur CE fichier.
Run: `npx tsc --noEmit -p .` — une nouvelle erreur est attendue dans `src/lib/import/run-shapefile-job.ts` (propriété `nbIncoherenceSection` manquante dans le littéral de repli) : c'est normal, Task 6 la résout. Ne signaler comme anomalie que des erreurs dans D'AUTRES fichiers que `run-shapefile-job.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/cadastre/assign-section-nicad.ts
git commit -m "feat(cadastre): enrich canonical fields + widen section resolution to all features + track section mismatches"
```

---

### Task 6: Câblage run-shapefile-job.ts + ErrType (run-job.ts)

**Files:**
- Modify: `src/lib/import/run-shapefile-job.ts` (littéral de repli `sectionNicad` + `reportExtra`)
- Modify: `src/lib/import/run-job.ts:37-39` (union locale `ErrType`)

**Interfaces:**
- Consumes: `assignSectionNicad`'s nouveau type de retour (Task 5, champ `nbIncoherenceSection`).
- Produces: rien de nouveau consommé ailleurs — dernière tâche de câblage avant la couche d'affichage (Task 7).

- [ ] **Step 1: Étendre le littéral de repli et `reportExtra` dans run-shapefile-job.ts**

Remplacer (bloc actuel) :
```ts
      await assertNotCancelled(jobId);
      let sectionNicad: Awaited<ReturnType<typeof assignSectionNicad>> = {
        nbConstruits: 0,
        nbSansSection: 0,
        nbSansNumeroParcelle: 0,
        warnings: [],
      };
      try {
        sectionNicad = await assignSectionNicad(features, fieldMapping);
      } catch (err) {
        // Construction du NICAD = valeur ajoutée au-dessus d'un import shapefile
        // réussi, pas un prérequis : une erreur ici (ex. jointure spatiale KO)
        // ne doit jamais faire échouer tout le job d'import.
        console.error(`[import/run-shapefile] assignSectionNicad échoué (job ${jobId}), import poursuivi sans NICAD construit:`, err);
        sectionNicad.warnings.push(
          "Construction automatique du NICAD indisponible pour cet import (erreur technique) — NICAD non construit.",
        );
      }

      await setJobPhase(jobId, "read", 20);
      await finishParcellesJob(
        jobId,
        { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType },
        features,
        {
          reportExtra: {
            nicadConstruits: sectionNicad.nbConstruits,
            ...(sectionNicad.warnings.length > 0 ? { warnings: sectionNicad.warnings } : {}),
          },
        },
      );
      return;
```
par :
```ts
      await assertNotCancelled(jobId);
      let sectionNicad: Awaited<ReturnType<typeof assignSectionNicad>> = {
        nbConstruits: 0,
        nbSansSection: 0,
        nbSansNumeroParcelle: 0,
        nbIncoherenceSection: 0,
        warnings: [],
      };
      try {
        sectionNicad = await assignSectionNicad(features, fieldMapping);
      } catch (err) {
        // Construction du NICAD = valeur ajoutée au-dessus d'un import shapefile
        // réussi, pas un prérequis : une erreur ici (ex. jointure spatiale KO)
        // ne doit jamais faire échouer tout le job d'import.
        console.error(`[import/run-shapefile] assignSectionNicad échoué (job ${jobId}), import poursuivi sans NICAD construit:`, err);
        sectionNicad.warnings.push(
          "Construction automatique du NICAD indisponible pour cet import (erreur technique) — NICAD non construit.",
        );
      }

      await setJobPhase(jobId, "read", 20);
      await finishParcellesJob(
        jobId,
        { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType },
        features,
        {
          reportExtra: {
            nicadConstruits: sectionNicad.nbConstruits,
            nbIncoherenceSection: sectionNicad.nbIncoherenceSection,
            ...(sectionNicad.warnings.length > 0 ? { warnings: sectionNicad.warnings } : {}),
          },
        },
      );
      return;
```

- [ ] **Step 2: Étendre l'union `ErrType` dans run-job.ts**

Remplacer (lignes 37-39) :
```ts
type ErrType =
  | "OVERLAP" | "GAP" | "SLIVER" | "DUPLICATE"
  | "INVALID_GEOM" | "BOUNDARY_CROSS" | "MISSING_NICAD" | "SHORT_NICAD" | "SELF_INTERSECT";
```
par :
```ts
type ErrType =
  | "OVERLAP" | "GAP" | "SLIVER" | "DUPLICATE"
  | "INVALID_GEOM" | "BOUNDARY_CROSS" | "MISSING_NICAD" | "SHORT_NICAD" | "SELF_INTERSECT"
  | "SECTION_MISMATCH";
```

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit -p .` — plus aucune erreur nouvelle dans `run-shapefile-job.ts` ni `run-job.ts` (l'erreur intermédiaire de Task 5 doit maintenant avoir disparu). Seules les 2 erreurs `RouteContext` de référence sont acceptables.
Run: `npx eslint src/lib/import/run-shapefile-job.ts src/lib/import/run-job.ts` — 0 erreur/warning.

- [ ] **Step 4: Commit**

```bash
git add src/lib/import/run-shapefile-job.ts src/lib/import/run-job.ts
git commit -m "feat(import): wire nbIncoherenceSection into job report, extend ErrType union with SECTION_MISMATCH"
```

---

### Task 7: Affichage carte (couleur + libellé)

**Files:**
- Modify: `src/lib/utils.ts:32-45` (`errorTypeColor`)
- Modify: `src/components/MapLibreMap.tsx` (`ERROR_TYPE_LABELS` — vers la ligne 98-108 dans l'état actuel du fichier, chercher le bloc par son contenu littéral plutôt que par ligne, un commit antérieur a légèrement décalé les numéros)
- Modify: `src/components/LeafletMap.tsx:6-16` (`ERROR_COLORS`)

**Interfaces:**
- Consumes: le type d'erreur `"section_mismatch"` / `"SECTION_MISMATCH"` (Task 4/Task 3).
- Produces: rien consommé ailleurs — dernière tâche de câblage fonctionnel avant la documentation.

- [ ] **Step 1: Étendre `errorTypeColor` (utils.ts)**

Remplacer (lignes 32-45) :
```ts
export function errorTypeColor(type: string): string {
  switch (type?.toLowerCase()) {
    case "overlap": return "#ef4444";
    case "gap": return "#f59e0b";
    case "sliver": return "#a855f7";
    case "duplicate": return "#3b82f6";
    case "invalid_geom": return "#ec4899";
    case "boundary_cross": return "#06b6d4";
    case "missing_nicad": return "#6366f1";
    case "short_nicad": return "#14b8a6";
    case "self_intersect": return "#f97316";
    default: return "#6b7280";
  }
}
```
par :
```ts
export function errorTypeColor(type: string): string {
  switch (type?.toLowerCase()) {
    case "overlap": return "#ef4444";
    case "gap": return "#f59e0b";
    case "sliver": return "#a855f7";
    case "duplicate": return "#3b82f6";
    case "invalid_geom": return "#ec4899";
    case "boundary_cross": return "#06b6d4";
    case "missing_nicad": return "#6366f1";
    case "short_nicad": return "#14b8a6";
    case "self_intersect": return "#f97316";
    case "section_mismatch": return "#84cc16";
    default: return "#6b7280";
  }
}
```

- [ ] **Step 2: Étendre `ERROR_TYPE_LABELS` (MapLibreMap.tsx)**

Chercher ce bloc littéral (les numéros de ligne ont légèrement dérivé récemment, ne pas se fier à un numéro fixe) :
```ts
const ERROR_TYPE_LABELS: Record<string, string> = {
  overlap: "Chevauchement",
  gap: "Trou",
  sliver: "Esquille",
  duplicate: "Doublon NICAD",
  invalid_geom: "Géométrie invalide",
  boundary_cross: "Sort des limites administratives",
  self_intersect: "Auto-intersection",
};
```
Le remplacer par :
```ts
const ERROR_TYPE_LABELS: Record<string, string> = {
  overlap: "Chevauchement",
  gap: "Trou",
  sliver: "Esquille",
  duplicate: "Doublon NICAD",
  invalid_geom: "Géométrie invalide",
  boundary_cross: "Sort des limites administratives",
  self_intersect: "Auto-intersection",
  section_mismatch: "Incohérence de section",
};
```

- [ ] **Step 3: Étendre `ERROR_COLORS` (LeafletMap.tsx)**

Remplacer (lignes 6-16) :
```ts
const ERROR_COLORS: Record<string, string> = {
  OVERLAP: "#ef4444",
  GAP: "#f59e0b",
  SLIVER: "#a855f7",
  DUPLICATE: "#3b82f6",
  INVALID_GEOM: "#ec4899",
  BOUNDARY_CROSS: "#06b6d4",
  MISSING_NICAD: "#6366f1",
  SHORT_NICAD: "#14b8a6",
  SELF_INTERSECT: "#f97316",
};
```
par :
```ts
const ERROR_COLORS: Record<string, string> = {
  OVERLAP: "#ef4444",
  GAP: "#f59e0b",
  SLIVER: "#a855f7",
  DUPLICATE: "#3b82f6",
  INVALID_GEOM: "#ec4899",
  BOUNDARY_CROSS: "#06b6d4",
  MISSING_NICAD: "#6366f1",
  SHORT_NICAD: "#14b8a6",
  SELF_INTERSECT: "#f97316",
  SECTION_MISMATCH: "#84cc16",
};
```

- [ ] **Step 4: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/lib/utils.ts src/components/MapLibreMap.tsx src/components/LeafletMap.tsx` — aucune nouvelle erreur/warning.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils.ts src/components/MapLibreMap.tsx src/components/LeafletMap.tsx
git commit -m "feat(map): add section_mismatch color/label to error display (utils, MapLibreMap, LeafletMap)"
```

---

### Task 8: Documentation (CLAUDE.md-mandated)

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md` — nouvelle section `## 19.`
- Modify: `docs/README.md` — référence la nouvelle section

**Interfaces:**
- Consumes: rien — tâche purement documentaire, dernière du plan.
- Produces: rien consommé ailleurs.

- [ ] **Step 1: Ajouter la section 19 dans CONCEPTS-TRAITEMENT-DXF.md**

Lire d'abord la fin du fichier (section `## 18.` la plus récente, ajoutée par le plan précédent `shapefile-parcelles-field-mapping`) pour trouver le point d'insertion exact et reprendre son style (Problème métier / Cause technique / Solution `fichier · fonction` / Pourquoi). Ajouter, après la fin de `## 18.` :

```markdown
## 19. Vérification de cohérence de section (shapefile page d'accueil) : section déclarée vs section géolocalisée

**Problème métier.** Le `.dbf` d'un shapefile déclare parfois une section
(`CodeSectio`/`codeSection`) qui ne correspond pas à la section réelle de la
parcelle telle que déterminée par sa position géographique — erreur de
saisie, redécoupage administratif non répercuté dans le fichier source, etc.
Sans contrôle, cette incohérence passait inaperçue : le NICAD était construit
(ou la parcelle laissée telle quelle si déjà NICADée) sans jamais comparer
la section déclarée à la réalité spatiale.

**Cause technique.** `assignSectionNicad` (avant ce correctif) ne résolvait
la section par jointure spatiale QUE pour les parcelles sans NICAD valide,
et n'avait aucune connaissance de la section « déclarée » dans le fichier
source (le champ `codeSection` n'était pas mappé sur ce chemin).

**Solution.** `field-mapping.ts · PARCELLES_HOME_TARGET_FIELDS` passe de 2 à
9 champs mappables (region, departement, commune, quartier, numLot,
superficie, codeSection, en plus de nicad/numParcelle). `assign-section-nicad.ts
· assignSectionNicad` enrichit désormais CHAQUE feature — indépendamment de
son statut NICAD — avec ces 7 champs sous forme de propriétés canoniques, et
élargit la résolution spatiale (`getSectionsForPoints`) à TOUTES les
features avec un point représentatif (pas seulement celles sans NICAD),
afin d'écrire une clé canonique `sectionGeolocalisee` (11 chiffres,
syscol+section) même sur les parcelles déjà NICADées. `nicad.ts ·
codeSectionsMatch` compare `codeSection` (déclaré) à `sectionGeolocalisee`
(trouvé), en tolérant un déclaré à 3 chiffres seul (numéro de section sans
préfixe syscol). `geo-engine.ts · analyzeGeoJSON` lit ces deux clés
canoniques dans sa boucle par-feature existante (même motif que la
détection `missing_nicad`) et pousse une erreur `section_mismatch`
(sévérité `high`), persistée comme toute autre erreur topologique — la
description nomme les deux valeurs et propose la section géolocalisée
comme correction. Une parcelle sans NICAD valide dont la section est
incohérente n'a PAS son NICAD construit (ni avec la section déclarée, ni
avec la géolocalisée) tant que l'incohérence n'est pas résolue
manuellement.

**Pourquoi.** La comparaison ne fait AUCUNE section autorité automatiquement
— une divergence peut aussi bien signaler une erreur du fichier source
qu'une lacune du référentiel `limite_section` (zone pas encore couverte,
limite mal tracée) ; forcer l'une ou l'autre risquerait de propager une
mauvaise attribution. Élargir la résolution spatiale aux parcelles déjà
NICADées (plutôt que de se limiter aux candidates NICAD, moins coûteux)
est un choix produit délibéré : détecter aussi les incohérences sur des
parcelles déjà attribuées, considéré plus complet que le gain de
performance du périmètre réduit — l'index GiST déjà en place sur
`limite_section.geom` (cf. §17) maintient ce coût raisonnable.
```

- [ ] **Step 2: Référencer depuis README.md**

Lire `docs/README.md` pour repérer l'entrée de la section 18 la plus récente et reproduire exactement son format (table + parcours de lecture) pour la nouvelle section 19.

- [ ] **Step 3: Vérifier**

Aucune vérification `tsc`/`eslint` requise pour cette tâche (fichiers Markdown uniquement). Relire les deux fichiers modifiés pour confirmer l'absence de faute de cohérence avec le code réellement écrit dans les tâches précédentes (noms de fonctions, de fichiers, de clés canoniques).

- [ ] **Step 4: Commit**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md docs/README.md
git commit -m "docs(cadastre): document section-coherence check for parcelles-home shapefile path (section 19)"
```

---

## Vérification manuelle (hors de portée de cet environnement sandboxé)

À documenter dans le rapport final comme suivi utilisateur obligatoire avant mise en production :
1. Appliquer la migration Prisma (`npx prisma migrate deploy` ou équivalent) sur une vraie base de données, puis `npx prisma generate`.
2. Démarrer `npm run dev`, déposer un `.shp`+`.dbf` réel avec les 9 colonnes listées (région, départeme, commune, VillageQua, CodeSectio, NumLot, numParcell, nicad, SupLegale/SupReelle).
3. Vérifier que la modale de mappage propose automatiquement les 9 champs avec les bonnes colonnes source pré-remplies.
4. Confirmer le mappage, vérifier sur `/map` que les propriétés canoniques (region/departement/commune/quartier/numLot/superficie/codeSection/sectionGeolocalisee) sont bien présentes sur les features.
5. Tester le cas de désaccord : modifier manuellement une valeur `CodeSectio` dans un `.dbf` de test pour qu'elle diverge de la réalité géographique, réimporter, et vérifier qu'une erreur « Incohérence de section » apparaît sur `/map` (couleur lime `#84cc16`) et dans le rapport IA, et que le NICAD de cette parcelle n'a pas été construit/modifié.
