# Migration en masse par import shapefile (NICAD) — design

Date : 2026-09-19
Statut : approuvé (brainstorming), en attente de plan d'implémentation

## Contexte

La page **« Migration en masse »** (`/cadastre/migration`) migre aujourd'hui
les NICAD 2013 → 2026 **par commune**, en relisant les parcelles déjà
présentes dans `cad_parcelles` (`version: "2013"`) pour la commune choisie.
Elle ne gère que le **cas simple** : elle réutilise `numSection` tel quel
(`executerMigrationCommune`, `src/lib/cadastre/data.ts`) — si la section a
été redécoupée entre 2013 et 2026, le NICAD migré pointe vers un numéro de
section qui n'existe plus ou ne correspond plus à la bonne zone.

La page **« Basculement 2013→2026 »** (`/cadastre/basculement`) gère
correctement les deux cas (simple ET complexe) mais **un seul NICAD à la
fois** : l'utilisateur saisit un NICAD 2013, `identifierBasculement`
(`src/app/cadastre/_actions/nicad.ts`) retrouve automatiquement la commune
2026 (table `cad_correspondance_2013_2026`) et vérifie par **jointure
spatiale** (`findSectionSpatialMatches`) si la section a été renumérotée,
puis `basculerNicadAction` applique le basculement (registre `cad_nicads`,
historique `cad_nicad_historique`).

Contrairement à la migration par commune, `basculerNicadAction` ne suppose
**pas** que le NICAD provient d'une parcelle déjà connue de ce système : il
opère uniquement sur le registre `cad_nicads` (`insertNicad` /
`updateNicadStatut`), et ne touche `cad_parcelles` que dans le cas complexe
(nouvelle numérotation). C'est le comportement voulu ici : les NICAD
importés par shapefile peuvent être externes/inconnus du système.

## Objectif

Permettre de traiter en masse une **liste de NICAD 2013 fournie par
shapefile** (au lieu d'une commune entière depuis la base), en appliquant à
chacun la même intelligence que `identifierBasculement` (cas simple ET
complexe), avec un **tableau de prévisualisation** des correspondances
proposées avant toute écriture — l'utilisateur valide (ligne par ligne ou en
bloc) avant que le basculement réel ne soit exécuté.

## Architecture

```
Upload shapefile (.zip .shp+.dbf)
        │
        ▼
POST /api/import-jobs  (kind: "bascule-nicad", sourceType: "SHP")
        │  (traitement en arrière-plan via after())
        ▼
run-bascule-job.ts
  ├─ lit le shapefile (réutilise loadShapefilePair, exporté depuis
  │  run-shapefile-job.ts)
  ├─ extrait le champ NICAD (mapping utilisateur, FieldMappingModal)
  ├─ dédoublonne + valide le format (16 chiffres)
  ├─ pour chaque NICAD valide : identifierBasculementNicad()
  │  (logique extraite de identifierBasculement, lib/cadastre/basculement.ts)
  ├─ setJobPhase("identify", ...) à intervalles réguliers (barre de
  │  progression — cf. leçon du §58 CONCEPTS-TRAITEMENT-DXF.md)
  └─ job.report = { items: [...], stats: {...} }  (job "completed")
        │
        ▼
UI /cadastre/migration : poll du job (même mécanisme que SectionsClient.tsx)
  → JobProgressSteps pendant l'identification
  → tableau de prévisualisation une fois le job "completed"
        │  (NICAD ancien | commune/section 2026 proposée | statut | drapeaux)
        ▼
Bouton "Basculer" (ligne) ou "Tout basculer" (lignes sans drapeau bloquant)
        │
        ▼
Server action executerBasculementListe()
  → boucle sur les lignes approuvées, appelle basculerNicadCore()
    (logique extraite de basculerNicadAction, lib/cadastre/basculement.ts)
  → résultats (succès/échec par ligne) affichés, historique mis à jour
```

## Composants

### `src/lib/cadastre/basculement.ts` (nouveau)

Extrait la logique métier aujourd'hui coincée dans le fichier `"use server"`
`_actions/nicad.ts`, pour la rendre appelable à la fois par l'action
interactive existante et par le nouveau job en masse (aucune duplication de
la logique de résolution spatiale/correspondance, déjà bien rodée) :

- `identifierBasculementNicad(nicadAncien: string): Promise<IdentificationResult>`
  — corps exact de `identifierBasculement` actuel, moins `requireUserId()`
  et le parsing zod (responsabilité de l'appelant).
- `basculerNicadCore(input: { nicadAncien, syscolNouveau, sectionNouvelle?, motif?, userId }): Promise<BasculementResult>`
  — corps exact de `basculerNicadAction` actuel, moins `requireUserId()`.

`_actions/nicad.ts` devient un mince wrapper (auth + validation zod + appel)
pour ces deux fonctions — comportement inchangé, aucune régression attendue
sur la page « Basculement » existante.

### `src/lib/import/field-mapping.ts` (modifié)

- `ShapefileTarget` gagne `"bascule-nicad"`.
- Nouveau `BASCULE_NICAD_TARGET_FIELDS: TargetFieldDef[]` : un seul champ,
  `{ key: "nicad", label: "NICAD (16 caractères)", aliases: [...même liste
  que PARCELLES_HOME_TARGET_FIELDS...], required: true }`.
- `targetFieldsFor` route vers ce nouveau tableau.

### `src/lib/import/jobs.ts` (modifié)

- `JobKind` gagne `"bascule-nicad"`.
- `JobPhase` gagne `"identify"`.
- Aucune migration Prisma : `kind`/`phase` sont des `String` en base (pas
  d'enum Prisma), seuls les types TypeScript changent.

### `src/lib/import/run-shapefile-job.ts` (modifié)

- Exporte `loadShapefilePair` (actuellement privé) pour réutilisation.
- Ajoute un cas `if (job.kind === "bascule-nicad")` qui délègue à
  `runBasculeNicadJob` (nouveau fichier ci-dessous) — même style que la
  délégation `run-job.ts` → `run-shapefile-job.ts`.

### `src/lib/import/run-bascule-job.ts` (nouveau)

```ts
export async function runBasculeNicadJob(jobId: number): Promise<void>
```

- Lit le shapefile (`loadShapefilePair`), extrait la colonne NICAD mappée.
- Dédoublonne, valide le format (16 chiffres) — invalides comptés à part,
  jamais inclus dans le rapport de prévisualisation.
- Pour chaque NICAD valide restant, appelle `identifierBasculementNicad`.
  `setJobPhase(jobId, "identify", pct)` mis à jour par lots (même pattern
  `onProgress` que `importParcellesFromFeatures` — leçon tirée du bug de
  progression shapefile corrigé la veille, §58).
- Stocke dans `job.report` :
  ```ts
  {
    kind: "bascule-nicad",
    items: Array<{
      nicadAncien: string;
      dejaAJour: boolean;
      clean: boolean;
      flags: string[];
      proposition: { syscolNouveau: string; sectionNouvelle?: string } | null;
      commune2013?: string; commune2026?: string;
    }>;
    stats: { total: number; invalides: number; dejaAJour: number; clean: number; avecDrapeaux: number };
  }
  ```
- Job passe à `"completed"` / `phase: "done"` une fois l'identification
  terminée — **aucune écriture en base** à ce stade (identification pure,
  pas de basculement).

### `src/app/cadastre/_actions/migration.ts` (modifié)

Nouvelle action :

```ts
export async function executerBasculementListe(input: {
  items: Array<{ nicadAncien: string; syscolNouveau: string; sectionNouvelle?: string }>;
})
```

- `requireAdmin()` (même garde que `executerCommune`/`executerToutes` —
  action destructrice, cohérent avec le reste de cette page).
- Boucle sur `items`, appelle `basculerNicadCore` pour chacun, capture les
  échecs par ligne sans interrompre les suivantes (même philosophie que
  `basculerBatch`, qui reste inchangé/inutilisé par ailleurs).
- Enregistre une `Operation` globale (comme `executerCommune`).

### `src/app/cadastre/migration/page.tsx` (modifié)

Nouvelle section sous le tableau existant (par commune, inchangé) :

- Bouton d'upload shapefile (`.zip`) — réutilise le composant/flux déjà
  éprouvé dans `SectionsClient.tsx` (upload → `POST
  /api/cadastre/import/inventory` → `FieldMappingModal` → `POST
  /api/import-jobs` avec `kind: "bascule-nicad"`).
- `JobProgressSteps` pendant que le job tourne (étapes : `read` → `identify`
  → `done`).
- Une fois le job `completed`, tableau de prévisualisation (colonnes : NICAD
  ancien, → commune/section 2026 proposée, statut, drapeaux) — bouton
  « Basculer » par ligne + bouton « Basculer les lignes sans drapeau » en
  haut du tableau, qui ne sélectionne QUE les lignes `clean: true` (exact
  même critère que `identifierBasculement` : `flags.length === 0`). Les
  lignes `dejaAJour` sont affichées grisées, non actionnables (même
  traitement que sur la page Basculement).

## Décisions actées pendant le brainstorming

1. **NICAD externes autorisés** — un NICAD du shapefile n'a pas besoin
   d'exister déjà dans `cad_parcelles` : cohérent avec le comportement
   actuel de `basculerNicadAction`, qui n'écrit que dans le registre
   `cad_nicads` (sauf cas complexe, qui crée une ligne `cad_parcelles`).
2. **Aucun basculement automatique en cas de drapeau** — contrairement à
   l'option initialement proposée (« basculer quand même, juste avertir »),
   l'utilisateur a demandé un **tableau de prévisualisation** systématique :
   aucune écriture tant que l'utilisateur n'a pas vu et approuvé chaque
   proposition. Le bouton « Tout basculer » ne s'applique qu'aux lignes
   sans drapeau ; les lignes avec drapeau nécessitent une action explicite
   par ligne.
3. **Logique métier extraite, pas dupliquée** — `identifierBasculement` et
   `basculerNicadAction` sont réécrits comme de minces wrappers autour de
   fonctions partagées (`basculement.ts`), pour que la page interactive et
   l'import en masse restent garantis identiques dans leur comportement de
   résolution (un futur correctif à la jointure spatiale profite aux deux
   chemins automatiquement).

## Gestion des erreurs et cas limites

- **Format NICAD invalide** dans le shapefile → exclu du rapport, compté à
  part (`stats.invalides`).
- **NICAD déjà 2026** (`dejaAJour`) → affiché séparément, non actionnable.
- **Aucune correspondance 2026** → drapeau explicite, `proposition: null`,
  ligne non basculable tant que l'utilisateur n'a pas choisi une commune
  cible manuellement (même limitation que la page Basculement aujourd'hui —
  **hors périmètre** d'ajouter un sélecteur manuel dans CETTE itération,
  cf. « Hors périmètre »).
- **NICAD cible déjà existant** au moment de l'exécution (course avec un
  autre basculement concurrent) → échec de cette ligne seule
  (`basculerNicadCore` renvoie déjà cette erreur), les autres lignes
  continuent.
- **Job annulé** en cours d'identification → `assertNotCancelled`, même
  pattern que les jobs shapefile existants.

## Hors périmètre (cette itération)

- Pas de sélecteur de commune cible manuel pour les lignes sans
  correspondance dans le tableau de prévisualisation — l'utilisateur bascule
  ces cas via la page « Basculement » existante (NICAD par NICAD), qui a
  déjà ce sélecteur. Pourrait être ajouté plus tard si le volume de ces cas
  s'avère significatif en usage réel.
- Pas de export du tableau de prévisualisation (CSV/shapefile) — écran
  uniquement pour cette itération.
- `basculerBatch` (action existante, jamais branchée à une page) n'est ni
  supprimée ni réutilisée — elle devient définitivement obsolète mais reste
  en place (aucune raison de la supprimer dans ce chantier, hors périmètre).

## Tests

Pas de suite de tests automatisés existante pour les jobs d'import cadastre
dans ce dépôt (seul `test:llm` est automatisé) — vérification manuelle
prévue, cohérente avec la pratique établie :

1. Shapefile de test avec un mélange volontaire : NICAD déjà 2026, NICAD
   2013 cas simple (section inchangée), NICAD 2013 cas complexe (section
   renumérotée — nécessite une commune de test avec correspondance
   spatiale déjà calculée), NICAD invalide/mal formé.
2. Vérifier le tableau de prévisualisation reflète correctement les 4 cas.
3. Basculer une ligne individuellement, vérifier `cad_nicads` +
   `cad_nicad_historique`.
4. Basculer en bloc les lignes sans drapeau, vérifier qu'aucune ligne
   drapeau n'a été touchée.
5. Réimporter le même shapefile après basculement → les NICAD basculés
   doivent apparaître `dejaAJour: true` (Syscol nouveau désormais reconnu
   comme 2026).
