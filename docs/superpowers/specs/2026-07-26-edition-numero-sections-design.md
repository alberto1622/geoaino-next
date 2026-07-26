# Édition du numéro pour les sections sans numéro — design

Date : 2026-07-26

## Problème

Certaines `limite_section` extraites d'un DXF ressortent sans `numSection`
(libellé absent ou hors du polygone lors de la jointure, cf.
`docs/CONCEPTS-TRAITEMENT-DXF.md` §11 / mémoire `sections-fusionnees-dissolve-commune`).
Aujourd'hui rien ne permet de leur attribuer un numéro depuis l'application :
seules la fusion, la découpe (résolution de chevauchement) et la suppression
existent.

## Portée

- Éditable : `numSection` uniquement, pour les sections où il est `null`.
  Une section déjà numérotée n'est pas éditable par cette fonctionnalité
  (hors scope — la correction d'un numéro existant passerait par la fusion).
- Deux points d'entrée UI : la table des sections (panneau latéral) et le
  popup carte au clic sur un polygone.
- Filtre dédié « Sans numéro (N) » pour repérer rapidement ces sections dans
  la table et sur la carte.
- Doublon : si le numéro saisi existe déjà pour la même commune
  (`syscolCommune`), l'API refuse (409) — l'utilisateur doit passer par la
  fusion manuelle existante si c'est réellement la même section.

## Backend

### `src/lib/cadastre/sections-data.ts`

- `getSection(id)` : étendre le `SELECT` pour renvoyer aussi `syscolCommune`
  et `commune` (déjà stockés, juste absents de la projection actuelle).
  Additif — ne casse pas les appelants existants (`correct/route.ts`,
  `merge/route.ts`) qui ignorent ces champs.
- `findSectionNumeroConflict(syscolCommune, numSection, excludeId)` : renvoie
  `{ id, commune }` de la première section en collision `(syscolCommune,
  numSection)` (hors `excludeId`), ou `null`. Si `syscolCommune` est `null`,
  renvoie toujours `null` (pas de commune connue → pas de contrôle possible).
  Requête indexée par `@@index([syscolCommune, numSection])` (déjà présent
  dans le schéma, pas de migration nécessaire).
- `updateSectionNumero(id, numSection)` : `UPDATE limite_section SET
  numSection = …, updatedAt = now() WHERE id = …`.

### `src/app/api/cadastre/sections/numero/route.ts` (nouveau)

`POST` — même garde d'auth que `correct`/`merge`/`delete`
(session requise + rôle `ADMIN`).

Body `{ sectionId: number, numSection: string }`.

Validation, dans l'ordre :
1. `sectionId` entier et `numSection` non vide (trim) → sinon 400.
2. Section introuvable → 404.
3. Section a déjà un numéro (`existing.numSection` non vide) → 409
   (« Cette section a déjà un numéro »). Garde défensive : l'UI n'expose
   l'édition que pour les sections sans numéro, mais l'API ne fait pas
   confiance au client.
4. Conflit `(syscolCommune, numSection)` avec une autre section → 409,
   message nommant la section en collision et suggérant la fusion.
5. Sinon : `updateSectionNumero`, réponse `{ success: true, sectionId,
   numSection }`.

Pas de recalcul de chevauchements ni de dissolution : cette action ne
modifie aucune géométrie, seulement l'attribut. La section reste un
fragment individuel dans `limite_section` (regroupement éventuel par
numéro = action manuelle de fusion, séparée).

## Frontend — `src/components/cadastre/SectionsClient.tsx`

Nouveaux états :
```
numeroEditId: number | null   // id de la section en édition inline (table)
numeroDraft: string           // valeur en cours de saisie (table)
savingNumero: number | null   // id en cours d'enregistrement (table + popup)
showUnnumberedOnly: boolean   // filtre actif
```

`performSetNumero(sectionId, rawValue)` — partagé table + popup :
- trim, refuse si vide (toast) ;
- POST `/api/cadastre/sections/numero` ;
- succès → `setSections(prev => prev.map(s => s.id === sectionId ? {
  ...s, numSection } : s))`, ferme l'édition, toast succès ;
- échec → toast d'erreur (message de l'API, y compris le 409 doublon).

Dérivés :
```
unnumberedCount = sections.filter(s => !s.numSection).length
displayedSections = showUnnumberedOnly
  ? sections.filter(s => !s.numSection)
  : sections
```

`displayedSections` remplace `sections` :
- dans la boucle de construction de `secGroup` (couche carte) ;
- dans le test `fitPendingRef` (`displayedSections.length > 0`) ;
- dans le rendu de la table des sections ;
- dans les dépendances des deux `useEffect` qui redessinent/restylent après
  reconstruction des couches (celui du merge highlight, celui du dessin
  principal). L'effet de zoom sur un chevauchement sélectionné continue de
  chercher dans `sections` (liste complète) — il doit fonctionner même si
  une des deux sections est filtrée hors vue.

Table — cellule numéro :
- si `numSection` renseigné : affichage actuel inchangé (pastille couleur +
  texte).
- si vide et pas en édition : bouton crayon « — » (`title="Attribuer un
  numéro de section"`), `stopPropagation` pour ne pas déclencher le zoom de
  ligne.
- si en édition (`numeroEditId === s.id`) : `<input>` (autofocus, Entrée =
  enregistrer, Échap = annuler) + boutons ✓/✗.

En-tête de la table : bouton filtre « Sans numéro (N) » à côté du titre
« Sections (n) », visible seulement si `unnumberedCount > 0`, état actif
mis en évidence (fond ambre). Titre affiché : `Sections (${displayedSections.length}${showUnnumberedOnly ? ` / ${sections.length}` : ""})`.

Popup carte (construit impérativement, comme les boutons fusion/suppression
existants) : si `!s.numSection`, ajoute un `<input>` + bouton « Attribuer »
avant les boutons fusion/suppression déjà présents ; Entrée dans le champ
déclenche le même bouton. Au succès, ferme le popup et appelle
`performSetNumero`.

Tooltip : ajoute un indice `⚠ sans numéro` (style cohérent avec l'indice
« chevauchement » déjà présent) quand `!s.numSection && !hasError`.

## Hors scope (explicitement écarté par les réponses precedentes)

- Édition de la commune/département/région.
- Édition géométrique du contour (redessiner/scinder un polygone).
- Renumérotation d'une section déjà numérotée par ce flux.
- Recalcul automatique des chevauchements après attribution (pas de
  changement géométrique).

## Documentation

Ajouter une entrée courte dans `docs/CONCEPTS-TRAITEMENT-DXF.md` (section
sections/numérotation existante) expliquant que l'unicité du numéro
attribué manuellement est vérifiée par `(syscolCommune, numSection)` et non
globalement, avec renvoi vers `sections-data.ts · findSectionNumeroConflict`.

## Tests

- Pas de suite de tests automatisés existante pour ce module (vérifié :
  actions similaires `correct`/`merge`/`delete` n'ont pas de tests). Suivre
  le même niveau : vérification manuelle via le serveur de dev (import d'un
  lot avec sections non numérotées, attribution table + popup, cas doublon,
  filtre).
