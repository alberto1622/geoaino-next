# Import shapefile depuis la page d'accueil : job asynchrone (sans mappage) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un `.shp`+`.dbf` déposé sur `/` (page d'accueil) doit suivre le même
chemin `ImportJob` (progression par phase/pourcentage, bouton Annuler) que le
DXF, au lieu de bloquer la requête HTTP via `POST /api/upload-geo` puis
`POST /api/analyses`. Contrairement au plan précédent
(`2026-08-11-shapefile-mapping-progression.md`), il n'y a **aucune** étape de
mappage de champs ici : ce chemin ne remplit pas de colonnes DB typées, il
conserve les propriétés `.dbf` telles quelles dans le GeoJSON de l'`Analysis`
— exactement comme un DXF ingéré conserve les siennes. Le NICAD est extrait
de façon générique à l'analyse (`extractNicad()`, `geo-engine.ts`), pas
construit par jointure spatiale comme pour le DXF.

**Architecture :** Trois idées, dans l'ordre :

1. **Extraire** le parsing shapefile de `src/app/api/upload-geo/route.ts`
   (`parseShapefileBuffers`, `reprojectFeaturesToWgs84`) vers une lib
   partagée `src/lib/import/geo-parse.ts`, réutilisable côté job. Copie
   exacte, zéro changement de comportement pour le chemin existant.
2. **Extraire** la « queue » commune du pipeline DXF `parcelles`
   (`run-job.ts`) — filtrage Sénégal → sauvegarde disque → `Analysis.create`
   → `analyzeGeoJSON` → rapport IA (best-effort) → insertion des erreurs →
   `Analysis.update` COMPLETED → `ImportJob` `completed` (guardé anti-cancel,
   cf. le fix déjà livré dans le plan précédent) — en une fonction partagée
   `finishParcellesJob(jobId, job, features, extra?)`. Le DXF l'appelle avec
   les features qu'il a ingérées + résolu le NICAD ; un nouveau chemin
   shapefile l'appellera avec les features lues telles quelles.
3. **Ajouter une branche** `job.kind === "parcelles"` dans
   `run-shapefile-job.ts` (parallèle aux branches `"sections"` et
   `"cad-parcelles"`/`"cad-sections"` déjà là) qui parse le shapefile puis
   appelle `finishParcellesJob`. Étendre `POST /api/import-jobs` (voie
   multipart) pour reconnaître un `.shp` parmi les fichiers envoyés,
   zipper `.shp`+`.dbf`(+`.prj`) et démarrer un job `sourceType: "SHP",
   kind: "parcelles"`. Brancher la page d'accueil dessus.

**Tech Stack :** Next.js 16 (App Router), Prisma, packages `shapefile` et
`jszip` (déjà dépendances), TypeScript strict.

## Global Constraints

- Le chemin DXF/DGN existant (`runDxfImportJob`, `POST /api/upload-geo` pour
  les autres formats) doit rester **comportementalement identique** — la
  Task 2 extrait une fonction, elle ne change ni les valeurs ni l'ordre des
  écritures pour le DXF.
- GeoJSON/KML/CSV restent sur l'ancien chemin synchrone
  (`/api/upload-geo`+`/api/analyses`) — **hors périmètre**, ne pas y toucher
  au-delà de ce que l'extraction de la Task 1 impose mécaniquement (import
  au lieu de définition locale).
- Aucune étape de mappage de champs pour ce chemin (contrairement au plan
  précédent) — les propriétés `.dbf` sont conservées telles quelles, le
  NICAD est extrait génériquement à l'analyse, pas construit par jointure
  spatiale (celle-ci reste réservée au DXF, qui n'a pas de NICAD dans le
  dessin).
- Toute écriture de statut `ImportJob` doit être guardée anti-annulation
  (`updateMany` + `status: { not: "cancelled" }`), même pattern que le fix
  du plan précédent — ne pas réintroduire la race déjà corrigée.
- Ce projet n'a pas de framework de test (pas de vitest/jest —
  `package.json` n'a que `eslint`). Vérification : `npx tsc --noEmit -p .`
  et `npx eslint <fichiers modifiés>` après chaque tâche. Les vérifications
  manuelles (`bun run dev` + navigateur) sont documentées mais
  probablement à sauter dans un environnement sans serveur — comme pour les
  deux plans précédents, le noter explicitement comme limitation acceptée,
  pas comme échec.
- Deux erreurs `Cannot find name 'RouteContext'` sont déjà connues et
  acceptées dans ce worktree (`src/app/api/import-jobs/[id]/route.ts` et
  `.../[id]/cancel/route.ts`) — limitation d'environnement (`.next/types/`
  jamais généré ici), pas un défaut de code. Ne pas les re-signaler comme
  nouvelles.

---

### Task 1: Extraire le parsing shapefile dans `src/lib/import/geo-parse.ts`

**Files:**
- Create: `src/lib/import/geo-parse.ts`
- Modify: `src/app/api/upload-geo/route.ts`

**Interfaces:**
- Produces: `ParseResult` (interface), `reprojectFeaturesToWgs84(features: unknown[]): unknown[]`,
  `parseShapefileBuffers(shpBuf: Buffer, dbfBuf?: Buffer, prjBuf?: Buffer): Promise<ParseResult>`.

- [ ] **Step 1: Lire le fichier actuel en entier**

Ouvrir `src/app/api/upload-geo/route.ts` et lire l'intégralité du fichier
avant de commencer — il contient aujourd'hui : les constantes `UTM28N`/`WGS84`,
l'interface `ParseResult`, la fonction `reprojectFeaturesToWgs84`, et la
fonction `parseShapefileBuffers`, mêlées avec le parsing DXF/DGN/GeoJSON/
KML/CSV/ZIP qui reste en place. Identifier exactement ces 4 éléments à
extraire (par leur contenu, pas par numéro de ligne — le fichier peut avoir
légèrement dérivé).

- [ ] **Step 2: Créer `src/lib/import/geo-parse.ts`**

Copier **exactement**, sans changement de logique, les 4 éléments identifiés
à l'étape 1 dans ce nouveau fichier, avec un en-tête JSDoc expliquant que
c'est une extraction (réutilisable par `run-shapefile-job.ts`, branche
`"parcelles"`, sans dupliquer la logique). L'import `shapefile` (`import *
as shapefile from "shapefile";`) doit être ajouté en haut du nouveau fichier
(déjà présent en haut de `upload-geo/route.ts` aujourd'hui — le déplacer,
pas le dupliquer, si plus rien d'autre dans `upload-geo/route.ts` n'en a
besoin après extraction — vérifier : la fonction `parseZip` de
`upload-geo/route.ts` appelle aussi `shapefile`-related logique via
`parseShapefileBuffers`, indirectement, donc `upload-geo/route.ts` n'a plus
besoin de l'import direct de `shapefile` après cette étape, seulement de
`parseShapefileBuffers` importé du nouveau module).

- [ ] **Step 3: Modifier `upload-geo/route.ts` pour importer depuis le nouveau module**

Remplacer les définitions locales de `UTM28N`, `WGS84`, `ParseResult`,
`reprojectFeaturesToWgs84`, `parseShapefileBuffers` par :

```ts
import { parseShapefileBuffers, type ParseResult } from "@/lib/import/geo-parse";
```

Retirer l'import direct `import * as shapefile from "shapefile";` de ce
fichier s'il n'est plus utilisé ailleurs dans le fichier (vérifier par
grep avant de retirer — s'il reste un usage, le garder).

Tous les appels existants à `parseShapefileBuffers(...)` dans
`upload-geo/route.ts` (voie directe `.shp`, et à l'intérieur de `parseZip`)
restent inchangés — seule la provenance de la fonction change.

- [ ] **Step 4: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/lib/import/geo-parse.ts src/app/api/upload-geo/route.ts
git add src/lib/import/geo-parse.ts src/app/api/upload-geo/route.ts
git commit -m "refactor(import): extract shapefile parsing into src/lib/import/geo-parse.ts"
```

Vérifier explicitement : `tsc`/`eslint` ne doivent montrer que les 2 erreurs
`RouteContext` déjà connues (sans rapport avec ces fichiers), rien de
nouveau.

---

### Task 2: Extraire la queue commune `finishParcellesJob` dans `run-job.ts`

**Files:**
- Modify: `src/lib/import/run-job.ts`

**Interfaces:**
- Produces: `export async function finishParcellesJob(jobId: number, job: { fileName: string; userId: string | null; sourceType: SourceType }, features: GeoJSON.Feature[], extra?: { statsExtra?: Record<string, unknown>; reportExtra?: Record<string, unknown> }): Promise<void>` — exportée (le prochain task l'importe depuis `run-shapefile-job.ts`).

- [ ] **Step 1: Lire `run-job.ts` en entier**

Le fichier définit aujourd'hui `runImportJob` (dispatcher, inchangé),
`runDxfImportJob` (le pipeline DXF complet). Repérer, dans la branche
principale de `runDxfImportJob` (celle qui n'est PAS `job.kind === "sections"`),
la séquence qui commence juste après la construction de `fc`/`totalBuilt`
(`parcellesToFeatureCollection(withNicad.parcelles)`) et se termine à la
dernière écriture `prisma.importJob.update(...)` (statut `"completed"`) —
c'est exactement cette séquence qu'il faut extraire.

- [ ] **Step 2: Extraire `finishParcellesJob`**

Créer une nouvelle fonction exportée dans ce même fichier, dont le corps est
cette séquence extraite, avec ces adaptations :

- Signature : `(jobId: number, job: { fileName: string; userId: string | null; sourceType: SourceType }, features: GeoJSON.Feature[], extra: { statsExtra?: Record<string, unknown>; reportExtra?: Record<string, unknown> } = {})`.
- Le point de départ (`filterOutOfSenegal(fc ...)`) devient
  `filterOutOfSenegal({ type: "FeatureCollection", features } as ...)` —
  utiliser `features` (le paramètre) au lieu de la variable locale `fc`.
- Ajouter `await assertNotCancelled(jobId);` juste avant l'appel à
  `setJobPhase(jobId, "analyze", 72)` (déjà présent dans le code actuel —
  vérifier qu'il y est bien, il devrait déjà être là dans le flux DXF
  existant).
- Toutes les écritures `prisma.importJob.update(...)` qui fixent un statut
  (celle à `progress: 88` et celle finale à `status: "completed"`)
  DOIVENT utiliser `prisma.importJob.updateMany({ where: { id: jobId,
  status: { not: "cancelled" } }, data: {...} })` — **pas** `update` nu. Ce
  garde anti-annulation existe déjà pour les 4 autres points d'écriture
  terminale du projet (cf. commit `427a84d` du plan précédent) ; cette
  nouvelle fonction doit suivre exactement le même pattern dès sa création,
  pas être corrigée après coup.
- Le calcul de `stats` (`{ ...result.stats, outOfSenegalCount,
  microstationReport: withNicad.report }` dans le code actuel) devient
  `{ ...result.stats, outOfSenegalCount, ...extra.statsExtra }`.
- L'objet `report` final (actuellement `{ ...(withNicad.report as unknown as
  Record<string, unknown>), totalFeatures, errorCount, conformityScore,
  outOfSenegalCount }`) devient `{ ...extra.reportExtra, totalFeatures,
  errorCount, conformityScore, outOfSenegalCount }`.
- `totalBuilt` dans l'écriture finale devient `features.length` (au lieu de
  la variable locale `totalBuilt` calculée depuis `fc.features.length` —
  équivalent, puisque `features` EST ce qu'était `fc.features`).

- [ ] **Step 3: Appeler `finishParcellesJob` depuis `runDxfImportJob`**

Remplacer la séquence extraite, dans `runDxfImportJob`, par un appel :

```ts
await finishParcellesJob(
  jobId,
  { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType },
  fc.features,
  { statsExtra: { microstationReport: withNicad.report }, reportExtra: withNicad.report as unknown as Record<string, unknown> },
);
return;
```

Vérifier que le comportement observable ne change pas : mêmes champs, même
ordre d'écriture logique, juste factorisé. `fc`/`totalBuilt` restent
calculés dans `runDxfImportJob` comme avant (juste avant l'appel), seule la
suite est déplacée.

- [ ] **Step 4: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/lib/import/run-job.ts
git add src/lib/import/run-job.ts
git commit -m "refactor(import): extract finishParcellesJob shared tail from the DXF pipeline"
```

Vérification manuelle impossible ici (pas de serveur/BD) — mais relire le
diff soi-même ligne à ligne pour confirmer qu'aucune valeur, aucun ordre
d'écriture n'a changé pour le chemin DXF (c'est un pur déplacement de code,
zéro nouvelle logique métier).

---

### Task 3: Branche `job.kind === "parcelles"` dans `run-shapefile-job.ts`

**Files:**
- Modify: `src/lib/import/run-shapefile-job.ts`

**Interfaces:**
- Consumes: `parseShapefileBuffers` (Task 1, `@/lib/import/geo-parse`); `finishParcellesJob` (Task 2, `./run-job.ts`).

- [ ] **Step 1: Lire le fichier actuel en entier**

`run-shapefile-job.ts` a aujourd'hui `loadShapefilePair` (déjà générique,
réutilisable tel quel) et `runShapefileImportJob` qui dispatch sur
`job.kind` : `"sections"`, puis `"cad-parcelles" || "cad-sections"`, puis un
`throw` pour tout le reste. Repérer précisément où insérer la nouvelle
branche (juste après le bloc `"sections"`, avant le bloc
`"cad-parcelles"/"cad-sections"` — ou après, l'ordre entre les deux blocs
existants n'a pas d'importance, seul l'ordre relatif au `throw` final
compte).

- [ ] **Step 2: Ajouter la branche `"parcelles"`**

```ts
if (job.kind === "parcelles") {
  const source = await shapefile.read(shpBuf, dbfBuf);
  let features = (source.features ?? []) as GeoJSON.Feature[];

  // Reprojection UTM28N → WGS84 si le .prj (persisté dans le ZIP, cf. Task 4)
  // l'indique — même heuristique que `parseShapefileBuffers`, mais ce chemin
  // relit directement via `shapefile.read` (features déjà en mémoire), donc
  // pas besoin de rappeler `parseShapefileBuffers` : juste sa logique de
  // reprojection si un .prj UTM28N a été inclus dans l'archive.
  const prjEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".prj"));
  if (prjEntry) {
    const prjText = await prjEntry.async("string");
    if (prjText.includes("UTM") && prjText.includes("28")) {
      features = reprojectFeaturesToWgs84(features) as GeoJSON.Feature[];
    }
  }

  await assertNotCancelled(jobId);
  await setJobPhase(jobId, "read", 20);
  await finishParcellesJob(jobId, { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType }, features);
  return;
}
```

**Important — accès au `.prj` :** `loadShapefilePair` (fonction existante,
inchangée) ne charge que `.shp`+`.dbf` depuis le ZIP, pas le `.prj`. Cette
nouvelle branche a besoin d'accéder au ZIP lui-même (pas seulement aux deux
buffers déjà extraits) pour chercher un `.prj` optionnel. Deux options,
choisir celle qui demande le moins de changement en lisant le code réel de
`loadShapefilePair` :
(a) élargir `loadShapefilePair` pour renvoyer aussi `prjBuf?: Buffer` (3ᵉ
champ optionnel dans son objet de retour), et adapter ses deux appelants
existants (`"sections"` et `"cad-parcelles"/"cad-sections"`) qui
détruisent aujourd'hui `{ shpBuf, dbfBuf }` — leur ajouter `prjBuf` sans
l'utiliser change rien pour eux ; ou
(b) garder `loadShapefilePair` inchangée et, dans CETTE branche
uniquement, recharger le ZIP soi-même (`loadImportUpload` + `JSZip.loadAsync`,
même 2 lignes que le début de `loadShapefilePair`) pour en extraire le
`.prj`.
Choisir (a) si `loadShapefilePair` est appelée une seule fois par branche
(refactor propre, sans duplication) ; sinon (b) est plus sûr pour ne rien
casser aux deux branches existantes. Décider en lisant le code réel du
fichier avant d'implémenter — ne pas deviner.

- [ ] **Step 3: Imports**

Ajouter en haut du fichier :
```ts
import { reprojectFeaturesToWgs84 } from "@/lib/import/geo-parse";
import { finishParcellesJob } from "./run-job.ts";
```
(Ajuster le chemin d'import de `finishParcellesJob` selon son emplacement
réel après la Task 2 — `./run-job` sans extension `.ts`, convention
TypeScript standard du reste du fichier.)

**Attention à un cycle d'import potentiel :** `run-job.ts` importe déjà
`runShapefileImportJob` depuis `./run-shapefile-job` (pour le dispatcher
`runImportJob`). Si `run-shapefile-job.ts` importe maintenant
`finishParcellesJob` depuis `./run-job`, cela crée un import circulaire
entre les deux fichiers. TypeScript/Node tolèrent generalement les cycles
d'imports de fonctions (pas de valeurs évaluées au chargement du module),
mais **vérifier avec `npx tsc --noEmit -p .` et un `bun run scripts/...`
si besoin** que ça compile et s'exécute sans `undefined` à l'exécution. Si
un problème de cycle apparaît, la solution est de déplacer
`finishParcellesJob` dans un troisième fichier neutre (ex.
`src/lib/import/finish-parcelles.ts`) importé par les deux runners plutôt
que l'un depuis l'autre — signaler ce choix dans le rapport si nécessaire,
ne pas se contenter d'ignorer une erreur de compilation.

- [ ] **Step 4: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/lib/import/run-shapefile-job.ts
git add src/lib/import/run-shapefile-job.ts
git commit -m "feat(import): add job.kind=parcelles branch to the shapefile job runner"
```

---

### Task 4: `POST /api/import-jobs` reconnaît un shapefile en voie multipart

**Files:**
- Modify: `src/app/api/import-jobs/route.ts`

**Interfaces:**
- Produces: la voie multipart de `POST /api/import-jobs` accepte désormais un `.shp`(+`.dbf`+`.prj` optionnel) parmi les `files` envoyés, en plus de `.dxf`/`.dgn`/`.zip`.

- [ ] **Step 1: Lire le fichier actuel en entier**

Repérer la voie multipart (après la voie JSON), qui fait aujourd'hui :
```ts
const formData = await req.formData();
const files = formData.getAll("files") as File[];
if (!files.length) { ...400... }
const candidate = files.find((f) => /\.(dxf|dgn|zip)$/i.test(f.name)) ?? files[0];
const source = await resolveSource(candidate);
if (!source) { ...400... }
const fileKey = await saveImportUpload(source.fileName, source.buffer);
return startJob(source, userId, undefined, fileKey);
```

- [ ] **Step 2: Ajouter la détection shapefile AVANT la logique DXF/DGN existante**

Juste après `if (!files.length) { ...400... }`, insérer :

```ts
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    if (shpFile) {
      const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
      if (!dbfFile) {
        return NextResponse.json(
          { error: "Sélectionnez le .shp ET son .dbf ensemble." },
          { status: 400 },
        );
      }
      const prjFile = files.find((f) => f.name.toLowerCase().endsWith(".prj"));

      const zip = new JSZip();
      zip.file(shpFile.name, Buffer.from(await shpFile.arrayBuffer()));
      zip.file(dbfFile.name, Buffer.from(await dbfFile.arrayBuffer()));
      if (prjFile) zip.file(prjFile.name, Buffer.from(await prjFile.arrayBuffer()));
      const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
      const fileKey = await saveImportUpload(`${shpFile.name.replace(/\.shp$/i, "")}.zip`, zipBuf);

      const source: ResolvedSource = {
        buffer: Buffer.alloc(0), // non utilisé (fichier déjà persisté sous fileKey)
        fileName: shpFile.name,
        sourceType: "SHP" as SourceType,
      };
      return startJob(source, userId, undefined, fileKey, "parcelles");
    }
```

Ce bloc réutilise EXACTEMENT le même pattern de zippage que
`POST /api/cadastre/import/inventory` (plan précédent) — lire ce fichier
existant pour confirmer la forme exacte de `saveImportUpload`/`JSZip` avant
d'écrire, ne pas réinventer.

Ajouter l'import `JSZip` en haut du fichier s'il n'y est pas déjà :
```ts
import JSZip from "jszip";
```
(vérifier par grep avant — il est possible qu'il soit déjà importé pour
une autre raison dans ce fichier).

Le reste de la voie multipart (candidate DXF/DGN/ZIP, `resolveSource`, etc.)
reste **entièrement inchangé**, en aval de ce nouveau bloc `if (shpFile)`.

- [ ] **Step 3: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/app/api/import-jobs/route.ts
git add src/app/api/import-jobs/route.ts
git commit -m "feat(import-jobs): accept a .shp+.dbf pair on the multipart POST /api/import-jobs path"
```

---

### Task 5: Brancher la page d'accueil sur ce nouveau chemin

**Files:**
- Modify: `src/components/HomeClient.tsx`

- [ ] **Step 1: Lire `handleFiles` en entier**

Aujourd'hui (`HomeClient.tsx`) :
```ts
  const handleFiles = useCallback(async (fileList: File[]) => {
    if (!fileList.length || isUploading || pendingInventory) return;

    const mainFile = fileList.find(
      (f) => !f.name.toLowerCase().endsWith(".dbf") && !f.name.toLowerCase().endsWith(".prj")
    ) || fileList[0];

    if (/\.(dxf|dgn)$/i.test(mainFile.name)) {
      void requestLayerInventory(fileList, mainFile);
      return;
    }

    // ... suite : /api/upload-geo puis /api/analyses (chemin synchrone) ...
  }, [...]);
```

- [ ] **Step 2: Ajouter la branche shapefile, avant le repli GeoJSON/KML/CSV**

Insérer, juste après le bloc `if (/\.(dxf|dgn)$/i.test(mainFile.name)) { ... }`
et avant la suite du corps de `handleFiles` :

```ts
    if (mainFile.name.toLowerCase().endsWith(".shp")) {
      void runCaoImport(fileList, mainFile);
      return;
    }
```

`runCaoImport` existe déjà dans ce fichier (voie multipart historique,
`POST /api/import-jobs` + `pollImportJob` + support Annuler déjà branché) —
elle envoie déjà TOUT `fileList` (donc `.shp`+`.dbf`+`.prj` ensemble) en
`multipart/form-data` vers `POST /api/import-jobs`. Aucune modification de
`runCaoImport` elle-même n'est nécessaire — Task 4 a déjà rendu cette route
capable de traiter un `.shp` parmi les fichiers reçus.

Si aucun fichier n'est ni `.shp` ni `.dbf` ni `.prj` reconnu du tout, le
flux retombe sur l'ancien chemin `/api/upload-geo` — comportement
acceptable, pas une régression (juste un cas déjà couvert avant ce plan).

- [ ] **Step 3: Vérification manuelle (à documenter comme sautée si pas de serveur)**

`bun run dev`, page d'accueil, sélectionner un `.shp`+`.dbf`(+`.prj`) :
confirmer que la barre de progression + le bouton Annuler apparaissent
(mode "import", comme pour un DXF), que le résultat final propose bien
"Voir sur la carte" → `/map/[analysisId]`, et que les propriétés `.dbf`
d'origine sont visibles dans la table attributaire de `/map`. Comparer le
résultat (nombre de features, erreurs détectées) à ce que produisait
l'ancien chemin synchrone sur le même fichier, pour confirmer l'absence de
régression fonctionnelle (seule la mécanique de progression/annulation
change, pas l'analyse elle-même).

- [ ] **Step 4: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/components/HomeClient.tsx
git add src/components/HomeClient.tsx
git commit -m "feat(home): route .shp uploads through the async import-job flow"
```

---

### Task 6: Documentation (`docs/CONCEPTS-TRAITEMENT-DXF.md` + `docs/README.md`)

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md`
- Modify: `docs/README.md`

Per `CLAUDE.md`, documenter dans `docs/CONCEPTS-TRAITEMENT-DXF.md` (vérifier
le numéro de section exact avant d'écrire — la dernière section existante
après le plan précédent est `15`, donc celle-ci devient probablement `16`) :

- **Problème métier** : un shapefile déposé sur la page d'accueil (menant à
  `/map`, contrairement aux shapefiles de `/cadastre/import`/`SectionsClient`
  qui visent `CadParcelle`/`CadSection`/`limite_section`) traitait
  jusqu'ici tout le pipeline (lecture + analyse topologique + rapport IA)
  de façon synchrone dans la requête HTTP, sans retour de progression, avec
  un risque de timeout sur un gros fichier.
- **Cause technique** : `handleFiles()` (`HomeClient.tsx`) ne routait vers le
  job asynchrone (`ImportJob`) QUE les fichiers `.dxf`/`.dgn` ; tout le
  reste (dont `.shp`) partait par `POST /api/upload-geo` +
  `POST /api/analyses`, un chemin plus ancien, entièrement synchrone.
- **Solution** (fichiers·fonctions) : `src/lib/import/geo-parse.ts`
  (parsing shapefile extrait, réutilisable), `finishParcellesJob`
  (`src/lib/import/run-job.ts`, queue commune DXF/shapefile pour la cible
  `Analysis`), branche `job.kind === "parcelles"`
  (`src/lib/import/run-shapefile-job.ts`), détection `.shp` dans la voie
  multipart de `POST /api/import-jobs`.
- **Pourquoi** : contrairement au plan de mappage de champs précédent (§15),
  ce chemin ne nécessite AUCUNE confirmation utilisateur — les propriétés
  `.dbf` sont conservées telles quelles (comme pour un DXF ingéré), et le
  NICAD est extrait génériquement à l'analyse plutôt que construit par
  jointure spatiale (réservée au DXF, qui n'a pas de NICAD dans le dessin).
  D'où un « traitement complet » plus léger que le plan précédent : job +
  progression + annulation, sans modale de mappage.

Ajouter la référence correspondante dans `docs/README.md`, même convention
que les entrées précédentes.

- [ ] **Step 1: Commit**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md docs/README.md
git commit -m "docs(import): document the home-page shapefile async-job path"
```

---

## Self-Review Notes

- **Pas de mappage de champs** : contrairement au plan précédent, ce plan
  ne touche PAS `src/lib/import/field-mapping.ts`, ne crée pas de
  `FieldMappingModal` supplémentaire, et n'ajoute pas d'endpoint
  d'inventaire — confirmé par la décision de portée prise avec l'humain.
- **Réutilisation stricte** : `runCaoImport`, `pollImportJob`,
  `handleCancelImport` (déjà dans `HomeClient.tsx`), `assertNotCancelled`/
  `JobCancelledError`/le pattern `updateMany` anti-cancel (déjà dans
  `jobs.ts`), `saveImportUpload`/`loadImportUpload` (déjà dans
  `storage.ts`) — aucun de ces éléments n'est recréé, seulement consommé.
- **Risque connu à surveiller en review** : Task 3 signale explicitement un
  risque de cycle d'import entre `run-job.ts` et `run-shapefile-job.ts` —
  ne pas laisser un implémenteur l'ignorer silencieusement si `tsc`/le
  runtime le signale.
