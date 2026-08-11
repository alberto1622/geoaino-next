# Import shapefile : mapping de champs + progression asynchrone — design

Date : 2026-08-11

## Problème

Le flux d'import DXF (page d'accueil, `HomeClient.tsx` → `/api/import-jobs`)
offre deux garanties que l'import shapefile n'a pas :

1. **Mapping vérifiable** : avant traitement, l'utilisateur voit les calques
   détectés, la classe DGID proposée automatiquement, et peut la corriger
   (`LayerMappingModal`).
2. **Progression suivie** : le traitement tourne en tâche de fond
   (`ImportJob` + `after()`), avec phases et pourcentage pollés côté client.

Le shapefile, lui, a trois entrées de code séparées, toutes synchrones et
sans confirmation de mapping :

- `/cadastre/import` (page « Import de données ») : `uploadShapefile()`
  (server action) → `importParcelles`/`importSections`/… — les noms de
  colonnes .dbf sont devinés via de longues chaînes `??` dans
  `src/lib/cadastre/import-data.ts`, sans que l'utilisateur ne voie ni ne
  corrige cette devinette. Les lignes sont écrites une par une dans une
  boucle `for` synchrone au sein d'une seule requête — aucun retour tant que
  tout le fichier n'est pas traité.
- `SectionsClient.tsx` (branche shapefile de `/cadastre/sections`) :
  `POST /api/cadastre/sections/import-shapefile`, synchrone lui aussi,
  numéro de section deviné via une liste d'alias figée
  (`sections-from-shapefile.ts`).

Objectif : amener ces deux flux shapefile au même niveau que le DXF —
mapping des champs confirmable + job asynchrone avec progression — sans
toucher aux imports Communes 2013/2026 et NICAD (CSV, hors scope, cf. plus
bas).

## Portée

- **Dans le périmètre** :
  - `/cadastre/import`, types **Parcelles** et **Sections** uniquement.
  - `SectionsClient.tsx`, branche shapefile (déjà couverte par `.dxf` côté
    job — on aligne juste `.shp`).
  - Ajout d'un bouton **Annuler** sur les jobs (DXF *et* shapefile).
- **Hors scope** :
  - `/cadastre/import`, types Communes 2013/2026 et NICAD (CSV) : restent
    synchrones, mapping deviné comme aujourd'hui (schémas simples, peu de
    champs, peu de valeur à ajouter un mapping).
  - Toute modification du pipeline DXF au-delà des points de contrôle
    d'annulation (aucun changement de logique métier DXF).
  - Historique/restauration (`CadHistoryEntry`, cf. spec
    `2026-08-06-cadastre-history-restore-design.md`) : les imports en masse
    restent hors de ce mécanisme, un rollback se fait via le lot
    `sourceFichier` existant.

## Architecture (bloc commun)

Réutilisation intégrale de l'infrastructure de job DXF :

- Table `ImportJob` (aucune migration de colonne : `sourceType` devient
  `"DXF" | "DGN" | "SHP"`, le JSON `layerMapping` est réutilisé pour porter
  le mapping de champs shapefile — sémantiquement plus large que son nom
  d'origine, mais sans changement de schéma).
- `setJobPhase()`, `GET /api/import-jobs/[id]` (polling), barre de
  progression : inchangés, déjà génériques.
- `runImportJob(jobId)` devient un **dispatcher** : `sourceType === "SHP"` →
  nouveau `runShapefileImportJob(jobId)` (`src/lib/import/run-shapefile-job.ts`) ;
  sinon → pipeline DXF existant (`run-job.ts`, inchangé sauf points de
  contrôle d'annulation, cf. plus bas).
- Nouveau composant `FieldMappingModal.tsx` (calqué visuellement sur
  `LayerMappingModal.tsx`) : au lieu d'une liste de calques → classes DGID,
  affiche une liste de **champs cibles** (fixe, définie par le type d'import)
  face aux **colonnes .dbf détectées**, avec proposition automatique
  (alias) éditable.
- Nouvel endpoint d'inventaire shapefile,
  `POST /api/cadastre/import/inventory` : upload → persistance disque
  (`saveImportUpload`, réutilisé tel quel) → lecture des noms de colonnes
  .dbf + un échantillon de valeurs (via le paquet `shapefile` déjà utilisé)
  → proposition de mapping par alias → retourne
  `{ fileKey, fileName, fields, proposedMapping }`.

### Extension de `JobKind`

```ts
// src/lib/import/jobs.ts
export type SourceType = "DXF" | "DGN" | "SHP";
export type JobKind = "parcelles" | "sections" | "cad-parcelles" | "cad-sections";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
```

- `"parcelles"` / `"sections"` restent le pipeline DXF existant (Analysis /
  `limite_section`) — **et** sont réutilisés pour la branche shapefile de
  `SectionsClient` (`kind: "sections"`, `sourceType: "SHP"` → même table
  `limite_section`, même report shape, donc le `useEffect` de polling et
  `reportBuildResult()` de `SectionsClient.tsx` n'ont **aucun changement** à
  subir).
- `"cad-parcelles"` / `"cad-sections"` sont nouveaux, réservés à
  `/cadastre/import` (écriture dans `CadParcelle` / `CadSection`).

## Mapping de champs par cible

Les listes ci-dessous reprennent **exactement** les alias déjà codés en dur
aujourd'hui (aucune perte de couverture) — elles deviennent la proposition
automatique pré-remplie dans `FieldMappingModal`, que l'utilisateur peut
corriger avant de lancer le job.

### Parcelles (`cad-parcelles` → `CadParcelle`)

nicad, codeSection (11 chiffres), numParcelle, commune, region,
departement, quartier, numLot, titreParce, typeDocFon, natJuri,
typeDestin, catOcup, superficie, proprietaire — 15 champs, repris de
`importParcelles()` (`src/lib/cadastre/import-data.ts:451-500`).

### Sections (`cad-sections` → `CadSection`)

numSectN (11 chiffres) *ou* syscol + numSection, nomSection, nomCommune,
region, departement — 5 champs, repris de `importSections()`
(`src/lib/cadastre/import-data.ts:370-376`).

### Sections (`sections` shapefile, `SectionsClient` → `limite_section`)

Un seul champ : numéro de section — repris de `extractNumSection()`
(`src/lib/cadastre/sections-from-shapefile.ts:63-75`). La commune est
résolue par jointure spatiale dans `buildLimiteSections`, comme pour le DXF
— pas de champ commune à mapper ici.

## Pipeline de traitement

### Extraction d'un noyau partagé (pas de régression sur le chemin existant)

`importParcelles`/`importSections` (`FichierInput[]`, devinette auto) sont
**conservées telles quelles** pour compatibilité (elles restent le chemin
utilisé par tout appelant qui ne passe pas par un job). On en extrait un
noyau commun :

```ts
// src/lib/cadastre/import-data.ts
export async function importParcellesFromFeatures(
  features: GeoJSON.Feature[],
  fieldMapping: Record<string, string> | undefined, // undefined = devinette auto (chemin legacy)
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult>
```

- Le chemin legacy (`importParcelles(fichiers)`) parse le shapefile puis
  appelle ce noyau avec `fieldMapping: undefined` → devinette auto identique
  à aujourd'hui, zéro changement de comportement.
- Le nouveau job appelle directement ce noyau avec le mapping confirmé par
  l'utilisateur et un `onProgress` qui appelle `setJobProgress()` par lots
  (tous les ~2 % de features traitées, pas à chaque ligne — évite de
  saturer la base de mises à jour).
- Même refactor pour `importSectionsFromFeatures`.

### Upload : disque plutôt que base64

Comme le DXF, le fichier est persisté via `saveImportUpload` dès la requête
d'inventaire (`POST /api/cadastre/import/inventory`), qui renvoie un
`fileKey`. La création du job (`POST /api/import-jobs`, inchangé) ne
retransmet que `{ fileKey, fileName, sourceType: "SHP", kind, layerMapping }`
— pas de re-upload, pas de gonflement de la requête pour les gros fichiers.

### Phases et progression

- `cad-parcelles` / `cad-sections` : `read` (5 %) → `import` (progressif,
  5→95 % par lots de features) → `done` (100 %).
- `sections` (shapefile) : `read` (5 %) → `build` (candidates, ~30 %) →
  `sections` (`buildLimiteSections`, ~70 %) → `done` (100 %) — mêmes libellés
  de phase que le job DXF `kind: "sections"` existant, donc `caoPhaseLabel()`
  côté client n'a rien à changer.

## Annulation

- `JobStatus` gagne `"cancelled"`.
- Nouvelle route `POST /api/import-jobs/[id]/cancel` : passe le job à
  `"cancelled"` s'il est `pending`/`running` (no-op sinon).
- Point de contrôle `assertNotCancelled(jobId)` inséré à chaque transition
  de phase existante :
  - **DXF** (`run-job.ts`) : ~5 points de contrôle, un avant chaque
    `setJobPhase()`/étape majeure (read, build, nicad, analyze, done) — pas
    de changement à la logique interne des étapes elles-mêmes (annulation à
    gros grain, entre étapes).
  - **Shapefile** (`run-shapefile-job.ts`) : même contrôle aux transitions de
    phase, **plus** un contrôle à chaque lot de progression (~2 % de
    features) — plus réactif, car c'est une simple boucle.
- Si annulé : le job **reste** au statut `"cancelled"` (le runner ne doit
  jamais l'écraser en `"completed"`/`"failed"` après coup) ; aucune ligne
  déjà écrite n'est retirée (pas de rollback — cohérent avec le hors-scope
  historique/restauration ci-dessus).
- Bouton « Annuler » visible tant que `job.status` est `pending`/`running`,
  sur les deux surfaces (`HomeClient`/`SectionsClient`/`/cadastre/import`).

## UI

### `/cadastre/import`

Pour `typeImport` **Parcelles**/**Sections** uniquement :

1. Sélection de fichier → `POST /api/cadastre/import/inventory` (upload +
   lecture des colonnes .dbf).
2. `FieldMappingModal` s'ouvre, pré-remplie par la proposition automatique.
3. Confirmation → `POST /api/import-jobs` (`sourceType: "SHP"`,
   `kind: "cad-parcelles" | "cad-sections"`) → polling → barre de
   progression (phase + %) + bouton Annuler, dans le même style que
   `HomeClient.tsx`.
4. Fin de job → même carte de résultat qu'aujourd'hui (`nbImportes`,
   `nbIgnores`, `nbErreurs`, `warnings` — lus depuis `job.report`).

Les autres types (`communes2013`, `communes2026`, `nicads`) gardent le
chemin `uploadShapefile()` synchrone actuel, inchangé.

### `SectionsClient.tsx`

La branche `isShapefile` de `handleUpload()` remplace son
`POST /api/cadastre/sections/import-shapefile` synchrone par : inventaire
(champ unique « numéro de section ») → `FieldMappingModal` (une seule ligne)
→ `POST /api/import-jobs` (`kind: "sections"`, `sourceType: "SHP"`) → le
`useEffect` de polling existant (déjà générique) prend le relais sans
modification. `reportBuildResult()` n'a pas besoin de changer : le report du
nouveau job shapefile a la même forme que celui du job DXF `sections`.

## Gestion des erreurs

- Fichier `.dbf` manquant à l'inventaire : même message d'erreur bloquant
  qu'aujourd'hui (`import-shapefile/route.ts:31-38`), avant même d'ouvrir la
  modale de mapping.
- Mapping incomplet (champ requis laissé vide) : le bouton de confirmation
  de `FieldMappingModal` reste désactivé tant qu'au moins un champ
  identifiant (nicad/codeSection pour parcelles, numSectN/syscol+numSection
  pour sections) n'est pas mappé.
- Erreurs par feature (comme aujourd'hui) : comptées dans
  `nbErreurs`/`warnings`, n'interrompent pas le job — seul un échec de
  lecture du fichier lui-même (`.shp` corrompu) marque le job `"failed"`.

## Tests

- Noyau `importParcellesFromFeatures`/`importSectionsFromFeatures` : tests
  unitaires avec mapping explicite vs `undefined` (devinette), vérifiant que
  le chemin legacy produit un résultat identique à l'actuel.
- `runShapefileImportJob` : test d'intégration sur un petit shapefile fixture
  → job `completed`, `report.nbImportes` correct, phases traversées dans
  l'ordre.
- Annulation : test envoyant `cancel` juste après la phase `read` → job
  `cancelled`, aucune ligne `CadParcelle`/`CadSection` créée après le point
  de contrôle suivant.

## Suivi documentation (post-implémentation)

Conformément à `AGENTS.md`/`CLAUDE.md` du projet, le nouveau mécanisme de
mapping de champs shapefile (et son interaction avec le dédoublonnage
NICAD/section déjà documenté) devra être ajouté à
`docs/CONCEPTS-TRAITEMENT-DXF.md` une fois implémenté, avec un renvoi depuis
`docs/README.md`.
