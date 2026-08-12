# Mapping numParcelle/NICAD avant traitement shapefile (page d'accueil) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une étape de mappage de champs (2 cibles : `nicad`, `numParcelle`) avant le traitement d'un shapefile déposé sur la page d'accueil (`job.kind === "parcelles"`), pour que la construction automatique du NICAD (jointure section, mergée dans `v4.0.0`) lise la bonne colonne `.dbf` au lieu de deviner par alias codés en dur.

**Architecture:** Réutilise l'infrastructure de mappage shapefile déjà éprouvée par `/cadastre/import` (`FieldMappingModal`, `buildShapefileFieldInventory`, `proposeFieldMapping`, l'endpoint `POST /api/cadastre/import/inventory`) plutôt que d'écrire un nouveau mécanisme. Un nouveau target minimal `"parcelles-home"` (2 champs, pas les 15 de `cad-parcelles`) est ajouté à `field-mapping.ts`. Le chemin page d'accueil bascule de l'upload multipart direct (`runCaoImport`) vers le flux inventaire→modale→job JSON déjà utilisé pour les DXF (`requestLayerInventory`/`startMappedImport`), avec repli sur l'import direct si l'inventaire échoue.

**Tech Stack:** Next.js App Router, TypeScript strict, Prisma/PostGIS, React (`"use client"`), pas de framework de test (vérification = `npx tsc --noEmit -p .` + `npx eslint <fichiers>`).

## Global Constraints

- Ne modifie QUE le chemin page d'accueil (`job.kind === "parcelles"`). `/cadastre/import` (`cad-parcelles`/`cad-sections`) et `SectionsClient` (`sections`) ne sont pas touchés.
- Le mappage porte sur exactement 2 champs : `nicad`, `numParcelle`. Aucun des 15 champs de `PARCELLE_TARGET_FIELDS` (commune, région, superficie, propriétaire, etc.) n'est ajouté au nouveau target — ces propriétés continuent de passer telles quelles dans le GeoJSON (`Analysis.geoJsonData`), inchangé depuis le plan `home-shapefile-import-job`.
- Aucun champ n'est `required: true` — un shapefile déposé sans mappage validé (ou avec des champs non mappés) doit continuer à fonctionner exactement comme aujourd'hui (repli sur le devinage par alias existant dans `assign-section-nicad.ts`), jamais bloquer l'import.
- Repli obligatoire sur l'import direct sans mappage (`runCaoImport`) si l'appel d'inventaire échoue (fichier illisible, erreur réseau) — même contrat que `requestLayerInventory` pour les DXF.
- Ne jamais écraser un NICAD déjà valide (contrainte héritée du plan `shapefile-section-nicad-join`, inchangée ici).

---

## File Structure

- `src/lib/import/field-mapping.ts` — **modifier** : nouveau target `"parcelles-home"` + ses 2 `TargetFieldDef`.
- `src/app/api/cadastre/import/inventory/route.ts` — **modifier** : accepter le nouveau target ; persister aussi le `.prj` s'il est présent dans la sélection (gap latent, absent aujourd'hui pour tous les targets).
- `src/app/api/import-jobs/route.ts` — **modifier** : autoriser `kind: "parcelles"` sur la voie JSON (déjà-uploadé-via-inventaire) ; router ce kind vers le nouveau target dans `shapefileTargetForKind`.
- `src/lib/cadastre/assign-section-nicad.ts` — **modifier** : `assignSectionNicad` accepte un `fieldMapping` optionnel, prioritaire sur le devinage par alias.
- `src/lib/import/run-shapefile-job.ts` — **modifier** : passer le `fieldMapping` déjà lu (`job.layerMapping`) à `assignSectionNicad` dans la branche `parcelles`.
- `src/components/HomeClient.tsx` — **modifier** : nouvelle branche `.shp` dans `handleFiles` → inventaire de champs → `FieldMappingModal` → job JSON avec `layerMapping`, repli sur `runCaoImport` si l'inventaire échoue.

---

### Task 1: Nouveau target `parcelles-home` dans field-mapping.ts

**Files:**
- Modify: `src/lib/import/field-mapping.ts:11` (union `ShapefileTarget`), `:23-39` (à côté de `PARCELLE_TARGET_FIELDS`), `:58-62` (`targetFieldsFor`)

**Interfaces:**
- Consumes: rien (fichier sans dépendance interne au-delà de `normalizeText`, déjà importé)
- Produces: `ShapefileTarget` inclut désormais `"parcelles-home"` ; `PARCELLES_HOME_TARGET_FIELDS: TargetFieldDef[]` (2 entrées, clés `"nicad"` et `"numParcelle"`) ; `targetFieldsFor("parcelles-home")` retourne ces 2 entrées. Consommé par `buildShapefileFieldInventory` (Task 2, via `targetFieldsFor`) et par `sanitizeFieldMapping` (Task 3, via `targetFieldsFor`).

- [ ] **Step 1: Étendre l'union `ShapefileTarget`**

Dans `src/lib/import/field-mapping.ts:11`, remplacer :
```ts
export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite";
```
par :
```ts
export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite" | "parcelles-home";
```

- [ ] **Step 2: Ajouter `PARCELLES_HOME_TARGET_FIELDS`**

Juste après la fermeture de `PARCELLE_TARGET_FIELDS` (après la ligne `];` qui suit `proprietaire`, actuellement ligne 39), insérer :
```ts

/**
 * Cibles de mappage pour le chemin shapefile de la page d'accueil
 * (job.kind === "parcelles" → Analysis.geoJsonData). Contrairement à
 * PARCELLE_TARGET_FIELDS (15 champs, colonnes DB typées de cad_parcelles),
 * ce chemin conserve TOUTES les propriétés .dbf telles quelles dans le
 * GeoJSON — seuls nicad et numParcelle sont mappés ici, car ce sont les 2
 * seuls champs dont dépend la construction automatique du NICAD
 * (assignSectionNicad, section-join). Mêmes alias que leurs homologues
 * PARCELLE_TARGET_FIELDS (aucune perte de couverture par rapport au
 * devinage actuel de assign-section-nicad.ts).
 */
export const PARCELLES_HOME_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "nicad", label: "NICAD (16 caractères)", aliases: ["nicad"] },
  { key: "numParcelle", label: "N° de parcelle", aliases: ["numparcell", "num_parce", "numparce", "numparcelle"] },
];
```

- [ ] **Step 3: Étendre `targetFieldsFor`**

Remplacer :
```ts
export function targetFieldsFor(target: ShapefileTarget): TargetFieldDef[] {
  if (target === "cad-parcelles") return PARCELLE_TARGET_FIELDS;
  if (target === "cad-sections") return CAD_SECTION_TARGET_FIELDS;
  return LIMITE_SECTION_TARGET_FIELDS;
}
```
par :
```ts
export function targetFieldsFor(target: ShapefileTarget): TargetFieldDef[] {
  if (target === "cad-parcelles") return PARCELLE_TARGET_FIELDS;
  if (target === "cad-sections") return CAD_SECTION_TARGET_FIELDS;
  if (target === "parcelles-home") return PARCELLES_HOME_TARGET_FIELDS;
  return LIMITE_SECTION_TARGET_FIELDS;
}
```

- [ ] **Step 4: Vérifier**

Run: `npx tsc --noEmit -p .`
Expected: aucune nouvelle erreur (seules les 2 erreurs `RouteContext` de référence, s'il y en a dans cet environnement — voir Task 6 pour le comportement observé en local).

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/field-mapping.ts
git commit -m "feat(import): add parcelles-home field-mapping target (nicad + numParcelle)"
```

---

### Task 2: Accepter le nouveau target + persister le .prj dans l'inventaire

**Files:**
- Modify: `src/app/api/cadastre/import/inventory/route.ts`

**Interfaces:**
- Consumes: `ShapefileTarget` (Task 1, inclut désormais `"parcelles-home"`), `buildShapefileFieldInventory(shpBuf, dbfBuf, target)` (inchangé, déjà générique via `targetFieldsFor`)
- Produces: la réponse JSON de `POST /api/cadastre/import/inventory` inclut désormais un `.prj` dans l'archive ZIP référencée par `fileKey`, s'il était présent dans la sélection de fichiers — consommé par `loadShapefilePair` dans `run-shapefile-job.ts` (Task 5, inchangé, lit déjà un `.prj` optionnel).

**Contexte du bug corrigé :** cet endpoint ne zippe aujourd'hui que `.shp`+`.dbf` (lignes 50-54), quel que soit le target. `runShapefileImportJob` → `loadShapefilePair` (déjà en prod) lit un `.prj` optionnel pour détecter une projection UTM28N et reprojeter (cf. plan `home-shapefile-import-job`, fix "carte vide sans .prj"). Tant que le chemin page d'accueil passait par l'upload multipart direct (`POST /api/import-jobs`, qui zippe lui aussi le `.prj` — voir `route.ts:167-172`), ce n'était pas un problème. En le faisant passer par CET endpoint (Task 6), le `.prj` serait silencieusement perdu sans ce correctif — régression du fix `home-shapefile-import-job`.

- [ ] **Step 1: Étendre `VALID_TARGETS`**

Dans `src/app/api/cadastre/import/inventory/route.ts:12`, remplacer :
```ts
const VALID_TARGETS: ShapefileTarget[] = ["cad-parcelles", "cad-sections", "sections-limite"];
```
par :
```ts
const VALID_TARGETS: ShapefileTarget[] = ["cad-parcelles", "cad-sections", "sections-limite", "parcelles-home"];
```

- [ ] **Step 2: Persister le `.prj` s'il est présent**

Remplacer (lignes 37-54) :
```ts
    const files = formData.getAll("files") as File[];
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
    if (!shpFile || !dbfFile) {
      return NextResponse.json(
        { error: "Fichier .shp ET .dbf requis (le .dbf porte les attributs à mapper)." },
        { status: 400 },
      );
    }

    const shpBuf = Buffer.from(await shpFile.arrayBuffer());
    const dbfBuf = Buffer.from(await dbfFile.arrayBuffer());

    const zip = new JSZip();
    zip.file(shpFile.name, shpBuf);
    zip.file(dbfFile.name, dbfBuf);
    const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const fileKey = await saveImportUpload(`${shpFile.name.replace(/\.shp$/i, "")}.zip`, zipBuf);
```
par :
```ts
    const files = formData.getAll("files") as File[];
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
    const prjFile = files.find((f) => f.name.toLowerCase().endsWith(".prj"));
    if (!shpFile || !dbfFile) {
      return NextResponse.json(
        { error: "Fichier .shp ET .dbf requis (le .dbf porte les attributs à mapper)." },
        { status: 400 },
      );
    }

    const shpBuf = Buffer.from(await shpFile.arrayBuffer());
    const dbfBuf = Buffer.from(await dbfFile.arrayBuffer());

    const zip = new JSZip();
    zip.file(shpFile.name, shpBuf);
    zip.file(dbfFile.name, dbfBuf);
    if (prjFile) zip.file(prjFile.name, Buffer.from(await prjFile.arrayBuffer()));
    const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const fileKey = await saveImportUpload(`${shpFile.name.replace(/\.shp$/i, "")}.zip`, zipBuf);
```

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/app/api/cadastre/import/inventory/route.ts`
Expected: aucune nouvelle erreur/warning.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cadastre/import/inventory/route.ts
git commit -m "fix(import): accept parcelles-home target, persist .prj in shapefile inventory zip"
```

---

### Task 3: Autoriser `kind: "parcelles"` sur la voie JSON de POST /api/import-jobs

**Files:**
- Modify: `src/app/api/import-jobs/route.ts:33-37` (`shapefileTargetForKind`), `:117-121` (validation `body.kind`)

**Interfaces:**
- Consumes: `ShapefileTarget` (Task 1), `targetFieldsFor` (Task 1, via `sanitizeFieldMapping` déjà générique)
- Produces: `POST /api/import-jobs` (voie JSON) accepte désormais `{ ..., sourceType: "SHP", kind: "parcelles", layerMapping: { nicad?, numParcelle? } }` — consommé par Task 6 (`HomeClient.tsx`).

- [ ] **Step 1: Router `kind === "parcelles"` vers le target `parcelles-home`**

Remplacer :
```ts
function shapefileTargetForKind(kind: string | undefined): ShapefileTarget {
  if (kind === "cad-sections") return "cad-sections";
  if (kind === "sections") return "sections-limite";
  return "cad-parcelles";
}
```
par :
```ts
function shapefileTargetForKind(kind: string | undefined): ShapefileTarget {
  if (kind === "cad-sections") return "cad-sections";
  if (kind === "sections") return "sections-limite";
  if (kind === "parcelles") return "parcelles-home";
  return "cad-parcelles";
}
```

- [ ] **Step 2: Autoriser `"parcelles"` dans la validation de kind (voie JSON)**

Remplacer :
```ts
        if (!body.kind || !["cad-parcelles", "cad-sections", "sections"].includes(body.kind)) {
          return NextResponse.json(
            { error: "kind requis pour un job shapefile (cad-parcelles|cad-sections|sections)." },
            { status: 400 },
          );
        }
```
par :
```ts
        if (!body.kind || !["cad-parcelles", "cad-sections", "sections", "parcelles"].includes(body.kind)) {
          return NextResponse.json(
            { error: "kind requis pour un job shapefile (cad-parcelles|cad-sections|sections|parcelles)." },
            { status: 400 },
          );
        }
```

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/app/api/import-jobs/route.ts`
Expected: aucune nouvelle erreur/warning. Vérifier en particulier que `body.kind as JobKind` (ligne ~133, inchangée) accepte bien `"parcelles"` — `JobKind` (`src/lib/import/jobs.ts:18`) l'inclut déjà.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/import-jobs/route.ts
git commit -m "feat(import): allow kind=parcelles on the JSON (already-uploaded) POST /api/import-jobs path"
```

---

### Task 4: assignSectionNicad lit le mappage validé en priorité

**Files:**
- Modify: `src/lib/cadastre/assign-section-nicad.ts`

**Interfaces:**
- Consumes: `FieldMapping` (type déjà exporté par `./field-mapping.ts`, `Record<string, string>`)
- Produces: `assignSectionNicad(features: GeoJSON.Feature[], fieldMapping?: FieldMapping): Promise<{ nbConstruits, nbSansSection, nbSansNumeroParcelle, warnings }>` — signature élargie (2e paramètre optionnel, tous les appels existants sans 2e argument restent valides). Consommé par Task 5 (`run-shapefile-job.ts`).

- [ ] **Step 1: Importer `FieldMapping`**

Dans `src/lib/cadastre/assign-section-nicad.ts:17`, remplacer :
```ts
import { validateNicadFormat } from "./nicad-logic";
```
par :
```ts
import { validateNicadFormat } from "./nicad-logic";
import type { FieldMapping } from "@/lib/import/field-mapping";
```

- [ ] **Step 2: `extractNumParcelle` accepte une clé de mappage explicite**

Remplacer la fonction actuelle (lignes 38-47) :
```ts
function extractNumParcelle(props: Record<string, unknown> | undefined | null): string | null {
  if (!props) return null;
  for (const alias of NUM_PARCELLE_ALIASES) {
    const hit = Object.entries(props).find(([k]) => k.toLowerCase() === alias);
    if (hit && hit[1] != null && String(hit[1]).trim()) {
      return normalizeNumeroParcelle(String(hit[1])).value;
    }
  }
  return null;
}
```
par :
```ts
/**
 * Colonne mappée explicitement par l'utilisateur (FieldMappingModal),
 * prioritaire sur le devinage par alias : une correspondance validée par
 * l'utilisateur ne doit jamais être contournée par une correspondance
 * fortuite avec un alias générique.
 */
function extractNumParcelle(
  props: Record<string, unknown> | undefined | null,
  mappedColumn?: string,
): string | null {
  if (!props) return null;

  if (mappedColumn) {
    const raw = props[mappedColumn];
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
```

- [ ] **Step 3: `assignSectionNicad` accepte et propage le mappage**

Remplacer la signature (ligne 64-66) :
```ts
export async function assignSectionNicad(
  features: GeoJSON.Feature[],
): Promise<{ nbConstruits: number; nbSansSection: number; nbSansNumeroParcelle: number; warnings: string[] }> {
```
par :
```ts
export async function assignSectionNicad(
  features: GeoJSON.Feature[],
  fieldMapping?: FieldMapping,
): Promise<{ nbConstruits: number; nbSansSection: number; nbSansNumeroParcelle: number; warnings: string[] }> {
```

Puis, dans la boucle de détection du NICAD existant (lignes 74-77) :
```ts
  for (let i = 0; i < features.length; i++) {
    const props = (features[i].properties ?? {}) as Record<string, unknown>;
    const existing = extractNicad(props);
    if (existing && validateNicadFormat(existing).valid) continue;
```
remplacer par :
```ts
  for (let i = 0; i < features.length; i++) {
    const props = (features[i].properties ?? {}) as Record<string, unknown>;
    const mappedNicadRaw = fieldMapping?.nicad ? props[fieldMapping.nicad] : undefined;
    const existing = mappedNicadRaw != null && String(mappedNicadRaw).trim()
      ? String(mappedNicadRaw).trim()
      : extractNicad(props);
    if (existing && validateNicadFormat(existing).valid) continue;
```

Enfin, dans le passage qui appelle `extractNumParcelle` (ligne 99-100) :
```ts
    const props = (features[c.index].properties ?? {}) as Record<string, unknown>;
    const numParcelle = extractNumParcelle(props);
```
remplacer par :
```ts
    const props = (features[c.index].properties ?? {}) as Record<string, unknown>;
    const numParcelle = extractNumParcelle(props, fieldMapping?.numParcelle);
```

- [ ] **Step 4: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/lib/cadastre/assign-section-nicad.ts`
Expected: aucune nouvelle erreur/warning.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cadastre/assign-section-nicad.ts
git commit -m "feat(cadastre): assignSectionNicad honors a validated field mapping over alias guessing"
```

---

### Task 5: Câbler le fieldMapping déjà lu dans run-shapefile-job.ts

**Files:**
- Modify: `src/lib/import/run-shapefile-job.ts:109`

**Interfaces:**
- Consumes: `assignSectionNicad(features, fieldMapping?)` (Task 4)
- Produces: rien de nouveau — branchement interne uniquement.

**Contexte :** `const fieldMapping = (job.layerMapping as FieldMapping | null) ?? undefined;` est déjà calculé en tête de fonction (ligne 52) et déjà utilisé par la branche `job.kind === "sections"` (ligne 62). Il ne l'est simplement pas encore par la branche `job.kind === "parcelles"`.

- [ ] **Step 1: Passer `fieldMapping` à `assignSectionNicad`**

Remplacer (ligne 108-109) :
```ts
      await assertNotCancelled(jobId);
      const sectionNicad = await assignSectionNicad(features);
```
par :
```ts
      await assertNotCancelled(jobId);
      const sectionNicad = await assignSectionNicad(features, fieldMapping);
```

(Le try/catch autour de cet appel, ajouté par le fix-wave de la revue finale du plan `shapefile-section-nicad-join`, est conservé tel quel — ne modifier que l'appel interne à `assignSectionNicad`, pas sa structure englobante.)

- [ ] **Step 2: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/lib/import/run-shapefile-job.ts`
Expected: aucune nouvelle erreur/warning.

- [ ] **Step 3: Commit**

```bash
git add src/lib/import/run-shapefile-job.ts
git commit -m "feat(import): thread the validated field mapping into section-join NICAD construction"
```

---

### Task 6: HomeClient.tsx — étape de mappage avant traitement du .shp

**Files:**
- Modify: `src/components/HomeClient.tsx`

**Interfaces:**
- Consumes: `POST /api/cadastre/import/inventory` (Task 2, target `"parcelles-home"`) → `{ fileKey, fileName, target, featureCount, fields: {name, sampleValues, nonEmptyCount}[], targetFields: TargetFieldDef[], proposedMapping: Record<string,string> }` ; `POST /api/import-jobs` voie JSON (Task 3) avec `kind: "parcelles"` ; composant `FieldMappingModal` (`src/components/FieldMappingModal.tsx`, props `{fileName, targetFields, availableFields, proposedMapping, onCancel, onConfirm}`, déjà utilisé par `/cadastre/import/page.tsx`).
- Produces: rien consommé ailleurs — c'est la dernière tâche du plan.

- [ ] **Step 1: Importer `FieldMappingModal` et son type de champ cible**

Dans `src/components/HomeClient.tsx:13`, après :
```ts
import LayerMappingModal, { type LayerInventoryEntry } from "@/components/LayerMappingModal";
```
ajouter :
```ts
import FieldMappingModal from "@/components/FieldMappingModal";
import type { TargetFieldDef } from "@/lib/import/field-mapping";
```

- [ ] **Step 2: Type de la réponse d'inventaire de champs + état local**

Après l'interface `LayerInventory` (lignes 16-21), ajouter :
```ts

interface ShapefileFieldInventory {
  fileKey: string;
  fileName: string;
  fields: { name: string; sampleValues: string[] }[];
  targetFields: TargetFieldDef[];
  proposedMapping: Record<string, string>;
}
```

Dans les déclarations d'état (après la ligne 91, `const [pendingInventory, setPendingInventory] = useState<LayerInventory | null>(null);`), ajouter :
```ts
  // Inventaire des champs .dbf en attente de validation (shapefile page d'accueil).
  const [pendingFieldInventory, setPendingFieldInventory] = useState<ShapefileFieldInventory | null>(null);
```

- [ ] **Step 3: `resetUpload` réinitialise aussi le nouvel état**

Dans `resetUpload` (lignes 94-104), après `setPendingInventory(null);`, ajouter :
```ts
    setPendingFieldInventory(null);
```

- [ ] **Step 4: Nouvelle fonction `startFieldMappedShapefileImport`**

Juste après la définition de `startMappedImport` (après sa fermeture, ligne 214 `);`), ajouter :
```ts

  /**
   * Démarre le job `parcelles` (page d'accueil) depuis un fichier déjà
   * téléversé (inventaire de champs) + mappage nicad/numParcelle validé.
   * Symétrique de `startMappedImport` (DXF/DGN, mappage de calques) pour le
   * mappage d'attributs shapefile.
   */
  const startFieldMappedShapefileImport = useCallback(
    async (fileKey: string, fileName: string, layerMapping: Record<string, string> | undefined) => {
      setMode("import");
      setIsUploading(true);
      setUploadFileName(fileName);
      setUploadStep("reading");
      setJobPhase("read");
      setJobProgress(0);
      setAnalysisResult(null);

      try {
        const res = await fetch("/api/import-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileKey,
            fileName,
            sourceType: "SHP",
            kind: "parcelles",
            layerMapping,
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(e.error || `Erreur serveur: ${res.status}`);
        }
        const { jobId } = (await res.json()) as { jobId: number };
        await pollImportJob(jobId);
      } catch (err) {
        toast.error("Erreur d'import", { description: String(err) });
        resetUpload();
      }
    },
    [pollImportJob, resetUpload],
  );
```

- [ ] **Step 5: Nouvelle fonction `requestShapefileFieldInventory`**

Juste après la définition de `runCaoImport` (après sa fermeture, ligne 244 `}, [pollImportJob, resetUpload]);`), ajouter :
```ts

  /**
   * Étape « mappage » pour un shapefile page d'accueil : inventorie les
   * colonnes .dbf (target `parcelles-home` : nicad + numParcelle
   * uniquement) puis ouvre la modale de mappage. En cas d'échec (fichier
   * illisible, erreur réseau), repli sur l'import direct sans mappage —
   * même contrat que `requestLayerInventory` pour les DXF.
   */
  const requestShapefileFieldInventory = useCallback(async (fileList: File[], shpFile: File) => {
    setMode("import");
    setIsUploading(true);
    setUploadFileName(shpFile.name);
    setUploadStep("reading");
    setAnalysisResult(null);

    try {
      const formData = new FormData();
      formData.append("target", "parcelles-home");
      fileList.forEach((f) => formData.append("files", f));

      const res = await fetch("/api/cadastre/import/inventory", { method: "POST", body: formData });
      if (!res.ok) throw new Error(String(res.status));
      const inv = (await res.json()) as ShapefileFieldInventory;

      // Suspend le spinner, la modale prend le relais jusqu'à validation.
      setIsUploading(false);
      setUploadStep(null);
      setPendingFieldInventory(inv);
    } catch {
      // Repli robuste : import direct via la voie multipart historique.
      await runCaoImport(fileList, shpFile);
    }
  }, [runCaoImport]);
```

- [ ] **Step 6: Router les `.shp` vers l'inventaire de champs dans `handleFiles`**

Remplacer (lignes 300-304) :
```ts
    const shpFile = fileList.find((f) => f.name.toLowerCase().endsWith(".shp"));
    if (shpFile) {
      void runCaoImport(fileList, shpFile);
      return;
    }
```
par :
```ts
    const shpFile = fileList.find((f) => f.name.toLowerCase().endsWith(".shp"));
    if (shpFile) {
      void requestShapefileFieldInventory(fileList, shpFile);
      return;
    }
```

Puis mettre à jour le tableau de dépendances de `handleFiles` (ligne 373) : remplacer `runCaoImport` par `requestShapefileFieldInventory` :
```ts
  }, [isUploading, pendingInventory, requestLayerInventory, requestShapefileFieldInventory]);
```

- [ ] **Step 7: Rendre `FieldMappingModal`**

Juste après le bloc `{pendingInventory && (...)}` (après sa fermeture, ligne 721 `)}`), ajouter :
```ts

      {pendingFieldInventory && (
        <FieldMappingModal
          fileName={pendingFieldInventory.fileName}
          targetFields={pendingFieldInventory.targetFields}
          availableFields={pendingFieldInventory.fields}
          proposedMapping={pendingFieldInventory.proposedMapping}
          onCancel={resetUpload}
          onConfirm={(mapping) => {
            const inv = pendingFieldInventory;
            setPendingFieldInventory(null);
            void startFieldMappedShapefileImport(inv.fileKey, inv.fileName, mapping);
          }}
        />
      )}
```

- [ ] **Step 8: Vérifier**

Run: `npx tsc --noEmit -p .` et `npx eslint src/components/HomeClient.tsx`
Expected: aucune nouvelle erreur/warning. Vérifier en particulier qu'aucune variable/fonction n'est laissée inutilisée (`runCaoImport` reste utilisé — par le repli de `requestShapefileFieldInventory` ET par `requestLayerInventory` pour les DXF, `startMappedImport` reste utilisé par les DXF).

- [ ] **Step 9: Vérification manuelle (nécessite un serveur dev + DB réelle, hors de portée de cet environnement sandboxé)**

Documenter dans le rapport de tâche que ce test manuel reste à faire par l'utilisateur :
1. Démarrer `npm run dev`, ouvrir la page d'accueil.
2. Déposer un `.shp`+`.dbf` (+ `.prj` optionnel) contenant une colonne de numéro de parcelle nommée de façon non standard (hors des alias codés en dur, ex. `PARC_NUM`).
3. Vérifier que la modale de mappage s'ouvre avec 2 lignes (NICAD, N° de parcelle), la colonne `.dbf` correcte proposée automatiquement si son nom correspond à un alias connu, sinon `— Non mappé —`.
4. Mapper manuellement `PARC_NUM` → N° de parcelle, cliquer "Lancer le traitement".
5. Vérifier sur `/map` que les NICAD ont été construits (jointure section) pour les parcelles ayant une section résolue.
6. Vérifier le repli : renommer le `.dbf` pour le rendre illisible (ou couper la connexion) et confirmer que l'import direct sans mappage se déclenche toujours sans erreur bloquante.

- [ ] **Step 10: Commit**

```bash
git add src/components/HomeClient.tsx
git commit -m "feat(home): add field-mapping step (nicad/numParcelle) before shapefile processing"
```

---

## Documentation (obligatoire, cf. CLAUDE.md)

Après le Task 6, ajouter une entrée dans `docs/CONCEPTS-TRAITEMENT-DXF.md` (nouvelle sous-section sous le §17 existant, ou §18 si le style du fichier appelle une nouvelle section numérotée) documentant : le problème (devinage par alias fragile), la cause (aucune confirmation utilisateur du nom de colonne .dbf), la solution (`PARCELLES_HOME_TARGET_FIELDS` · `assignSectionNicad` · `HomeClient.tsx`), le pourquoi (réutilisation de l'infra `FieldMappingModal` existante plutôt qu'un nouveau mécanisme, et le correctif `.prj` au passage). Référencer depuis `docs/README.md` (même convention que les entrées §15/§16/§17). Cette tâche documentaire doit être confiée à l'implémenteur du Task 6 (dernier task du plan) ou traitée comme un Task 7 séparé si le contrôleur SDD préfère isoler la vérification documentaire.
