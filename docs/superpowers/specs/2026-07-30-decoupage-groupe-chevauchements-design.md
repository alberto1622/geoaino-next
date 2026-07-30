# Découpages groupés des chevauchements de sections — design

Date : 2026-07-30

## Problème

`SectionsClient.tsx` résout aujourd'hui les chevauchements de `limite_section`
un par un : chaque carte de chevauchement propose 6 actions individuelles
(`clip_a`, `clip_b`, `merge`, `delete_a`, `delete_b`, `ignore`) via
`POST /api/cadastre/sections/correct`. Un lot importé peut contenir des
dizaines de chevauchements à découper — les traiter un par un est lent.
L'utilisateur veut pouvoir sélectionner plusieurs chevauchements et leur
appliquer une même règle de découpe (ou d'ignorance) en une seule opération.

## Portée

- Sélection manuelle multiple (checkboxes) dans la liste des chevauchements
  `PENDING`, avec une checkbox « tout sélectionner ».
- Barre d'action groupée, visible dès qu'au moins un chevauchement est
  sélectionné, avec 4 règles :
  - **Découper A** — découpe systématiquement la première section (`aNumSection`)
    de chaque chevauchement sélectionné.
  - **Découper B** — idem pour la seconde section (`bNumSection`).
  - **Auto (garder la plus petite)** — pour chaque chevauchement, calcule
    l'aire de A et de B et découpe la plus grande.
  - **Ignorer** — marque en masse les chevauchements sélectionnés comme
    `IGNORED` (intentionnels), aucune modification géométrique.
- Traitement séquentiel : si un élément du lot échoue (ex. section déjà
  supprimée par une correction précédente du même lot), les autres continuent
  — pas de rollback global. Un rapport final indique réussites/échecs.
- **Hors scope** : fusion et suppression en masse restent des actions au cas
  par cas (trop sensibles pour un traitement groupé) — uniquement disponibles
  individuellement, comme aujourd'hui.

## Backend

### `src/lib/cadastre/overlap-correction.ts` (nouveau)

Extrait la logique aujourd'hui inline dans `correct/route.ts` (résolution
d'UN chevauchement) pour la partager entre l'endpoint existant et le nouvel
endpoint batch.

```ts
type Action = "clip_a" | "clip_b" | "auto" | "merge" | "delete_a" | "delete_b" | "ignore";

export async function applyOverlapCorrection(
  overlapId: number,
  action: Action,
): Promise<{ sourceFichier: string }>
```

- Reprend telle quelle la logique actuelle de `correct/route.ts` : charge
  l'overlap (`getOverlap`), les deux sections (`getSection`), applique
  `turf.difference`/`turf.union`/suppression selon l'action, retourne le
  `sourceFichier` de l'overlap traité (nécessaire à l'appelant pour le
  `refreshOverlaps` final).
- **Ne fait plus le `refreshOverlaps` elle-même** — remonté à l'appelant, pour
  que le traitement batch ne le fasse qu'une seule fois à la fin du lot au
  lieu d'une fois par item.
- Nouvelle action `"auto"` : calcule `turf.area(fa)` et `turf.area(fb)`
  (mêmes `fa`/`fb` déjà construits pour `clip_a`/`clip_b`) et se comporte
  comme `clip_a` si `aire(A) > aire(B)`, sinon comme `clip_b` — découpe
  toujours la plus grande, garde la plus petite intacte (à aire égale,
  découpe B).
- Erreurs (overlap introuvable, section introuvable, fusion impossible)
  lancées comme `Error` avec message clair — à charge de l'appelant de les
  catcher (le batch les capture par item, `/correct` les laisse remonter
  comme avant).

### `src/app/api/cadastre/sections/correct/route.ts` (existant, simplifié)

Remplace le corps de la logique par un appel à `applyOverlapCorrection`,
suivi du `refreshOverlaps(sourceFichier)` déjà présent. Comportement pour
l'utilisateur strictement inchangé (mêmes actions, mêmes réponses).

### `src/app/api/cadastre/sections/correct-batch/route.ts` (nouveau)

`POST` — même garde d'auth que `correct` (session requise + rôle `ADMIN`).

Body `{ overlapIds: number[], action: "clip_a" | "clip_b" | "auto" | "ignore", sourceFichier?: string | null }`
(volontairement un sous-ensemble d'`Action` — `merge`/`delete_a`/`delete_b`
exclus du batch, cf. portée). `sourceFichier` reflète la vue actuellement
affichée côté client (un lot précis, ou `null`/absent pour « tous les
lots ») — sert uniquement à la réponse finale (`listSections`/`listOverlaps`),
pas au traitement lui-même (chaque item résout son propre `sourceFichier`
via `getOverlap`).

1. Validation : `overlapIds` tableau non vide d'entiers, `action` dans
   l'ensemble autorisé → sinon 400.
2. Boucle séquentielle (pas de `Promise.all` — les corrections modifient des
   géométries partagées, un traitement parallèle pourrait lire des états
   périmés) : pour chaque `overlapId`, appelle `applyOverlapCorrection`,
   capture le résultat dans `results: {overlapId, ok, error?}[]`, accumule
   chaque `sourceFichier` résolu dans un `Set<string>` — la vue « tous les
   lots » (`sourceFichier` courant `null`) peut afficher des chevauchements de
   plusieurs lots importés séparément, la sélection groupée peut donc en
   mélanger plusieurs.
3. Après la boucle : `refreshOverlaps(sourceFichier)` pour **chaque**
   `sourceFichier` distinct du `Set` (pas seulement le premier) — sinon les
   chevauchements resterait périmés pour les lots dont seul un item a été
   traité en second.
4. Réponse `{ results, sections, overlaps }` via
   `listSections(sourceFichier ?? null)`/`listOverlaps(sourceFichier ?? null)`
   — le `sourceFichier` du body (vue courante côté client), pas déduit des
   lots effectivement touchés côté serveur.

## Frontend — `src/components/cadastre/SectionsClient.tsx`

Nouvel état : `selectedOverlapIds: Set<number>` (même pattern que
`activeMergeSelection`, déjà utilisé pour la sélection multiple de sections
à fusionner).

- Checkbox par ligne dans la liste `pending.map(...)` (à côté de l'icône
  `⚠`), `stopPropagation` pour ne pas déclencher la sélection de ligne
  existante (`setSelectedOverlapId`).
- Checkbox « tout sélectionner » en tête de liste (visible si
  `pending.length > 0`), état indéterminé si sélection partielle.
- Barre d'action groupée (visible si `selectedOverlapIds.size > 0`), au-dessus
  de la liste : 4 boutons — Découper A / Découper B / Auto / Ignorer —
  chacun affiche le nombre sélectionné (`Découper A (12)`).
- Chaque bouton ouvre le dialogue de confirmation existant (réutilise
  `confirmState`) avec un message récapitulatif, ex. : « Découper la section A
  sur 12 chevauchement(s) sélectionné(s). Action irréversible. »
- `performBatchCorrection(ids: number[], action)` :
  - `POST /api/cadastre/sections/correct-batch` avec
    `{ overlapIds: ids, action, sourceFichier }` (l'état `sourceFichier` du
    composant — vue courante, `null` si « tous les lots ») ;
  - au succès : `setSections(data.sections)`, `setOverlaps(data.overlaps)`,
    vide `selectedOverlapIds` ;
  - toast : compte `ok=true`/`ok=false` dans `data.results` → succès simple
    si tout est `ok` (`"12 correction(s) appliquée(s)"`), sinon toast
    d'avertissement (`"9 correction(s) appliquée(s), 3 échouée(s)"`) et
    `console.warn` du détail (`overlapId` + message) pour investigation —
    pas de liste déroulante dédiée dans l'UI (hors scope, cohérent avec le
    niveau de finition des toasts existants).

## Hors scope (explicitement écarté par les réponses précédentes)

- Fusion et suppression en masse (restent action par action).
- Sélection automatique par critère (commune, paire récurrente) — seulement
  sélection manuelle via checkboxes.
- Rollback transactionnel du lot en cas d'échec partiel — le traitement
  continue et rapporte, il n'annule pas les corrections déjà appliquées.
- Annulation/undo d'un lot déjà appliqué.

## Tests

Pas de suite de tests automatisés existante pour ce module (`correct`/
`merge`/`delete` n'en ont pas non plus). Même niveau : vérification manuelle
via le serveur de dev — importer un lot avec plusieurs chevauchements,
sélectionner un sous-ensemble, tester chacune des 4 règles, vérifier le cas
d'échec partiel (ex. sélectionner deux chevauchements partageant une même
section, découper — le second doit échouer proprement si la section a
disparu, sans bloquer le reste), vérifier `tsc --noEmit` et `eslint` propres.
