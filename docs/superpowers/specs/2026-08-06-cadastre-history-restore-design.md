# Historique et restauration des modifications (sections & parcelles) — design

Date : 2026-08-06

## Problème

Sur `/cadastre/sections`, les actions destructives (`delete`, `numero`,
`correct`, `correct-batch`, `merge`, `nicad-fill`) écrivent directement dans
`CadSection` / `CadParcelle` / `LimiteSection` sans laisser aucune trace ni
possibilité de retour en arrière : une mauvaise fusion ou suppression est
définitive. Sur `/map` (page d'analyse d'un import DXF), un annuler/rétablir
existe déjà (`useUndoHistory`, cf. `src/hooks/use-undo-history.ts`) mais il
est volontairement en mémoire — perdu au rechargement de la page. Le seul
journal actuel, `CadOperationLog`, ne garde que des compteurs agrégés
(succès/échecs), pas d'état exploitable pour revenir en arrière.

Le besoin : un historique **persistant en base**, couvrant les deux pages,
permettant de **restaurer en un clic** n'importe quel point passé (pas
seulement d'annuler la toute dernière action).

## Portée

- Couvre les actions destructives des deux pages :
  - `/cadastre/sections` : `delete`, `numero`, `correct`, `correct-batch`,
    `merge`, `nicad-fill`.
  - `/map` : suppression et renommage NICAD (les deux mutations déjà
    couvertes par `MapHistoryEntry` côté client).
- **Hors scope** : `import` / `import-shapefile` (création en masse, traités
  différemment — pas de "avant" à sauvegarder, et un rollback d'import est
  déjà géré via la notion de lot `sourceFichier`).
- Persistance en base (survit au F5, partagée entre sessions), restauration
  en un clic depuis une liste complète navigable (pas juste "annuler la
  dernière action").
- Restauration réservée au rôle **ADMIN**, comme les autres actions
  destructives (cf. RBAC déjà en place).

## Modèle de données

Nouvelle table Prisma, transversale aux deux pages :

```prisma
model CadHistoryEntry {
  id            Int       @id @default(autoincrement())
  scope         String    // "sections" | "map"
  scopeKey      String?   // syscolCommune (sections, meilleur effort) | analysisId (map)
  action        String    // "delete" | "numero" | "correct" | "correct-batch" | "merge" | "nicad-fill" | "map-delete" | "map-rename" | "restore"
  summary       String    // texte lisible, ex. "Suppression de 3 sections (012, 013, 014 — Thiès)"
  before        Json      // snapshot complet nécessaire pour annuler
  after         Json      // état résultant (diff affiché + support d'un futur rétablir)
  restoredAt    DateTime? // renseigné quand cette entrée a servi de cible de restauration
  restoredBy    String?
  createdAt     DateTime  @default(now())
  createdBy     String?

  @@index([scope, scopeKey, createdAt])
  @@map("cad_history_entries")
}
```

- **Une entrée = une action utilisateur**, pas une ligne de table : les
  actions multi-lignes (`correct-batch`, `merge`, `nicad-fill`) produisent une
  seule entrée dont `before`/`after` listent toutes les lignes affectées —
  même principe que `MapSnapshot` déjà utilisé sur `/map`
  (`src/components/MapAnalysisClient.tsx:135`).
- Pas de clé étrangère typée vers `CadSection`/`CadParcelle` : les lignes
  peuvent avoir été supprimées entre-temps, donc `before`/`after` doivent être
  auto-suffisants (snapshot complet des lignes, pas juste leurs id).
- `restoredAt`/`restoredBy` sont indicatifs (affichage "restauré le…" dans la
  liste) — ils ne remplacent pas une nouvelle entrée d'audit (voir plus bas).

## Flux serveur

### Capture

Chaque route mutante lit l'état courant des lignes concernées **avant**
modification, applique son changement, puis insère l'entrée
`CadHistoryEntry` — le tout dans le **même `prisma.$transaction`** que la
mutation. Si l'écriture de l'historique échoue, toute la transaction est
annulée : impossible qu'une action réussisse sans laisser de trace annulable.

Un helper partagé centralise l'écriture pour éviter la répétition dans les
8 routes concernées :

```ts
// src/lib/cadastre/history.ts (nouveau)
export function recordHistory(
  tx: Prisma.TransactionClient,
  entry: {
    scope: "sections" | "map";
    scopeKey?: string;
    action: string;
    summary: string;
    before: unknown;
    after: unknown;
    createdBy?: string;
  },
): Prisma.PrismaPromise<CadHistoryEntry>
```

Point le plus sensible par route : capturer **tout le graphe affecté**, pas
juste l'entité de premier niveau — ex. supprimer une section doit aussi
sauvegarder ses parcelles et les chevauchements liés dans `before`, sinon la
restauration laisse des données orphelines. Le plan d'implémentation détaille
ce graphe pour chacune des 6 actions sections + 2 actions map.

### Restauration

Route générique unique :

```
POST /api/cadastre/history/[id]/restore
```

1. Vérifie la session + le rôle **ADMIN** (403 sinon).
2. Charge l'entrée, dispatch sur `action` vers la fonction de retour en
   arrière correspondante (petit registre `{ delete: revertDelete, numero:
   revertNumero, correct: revertCorrect, "correct-batch":
   revertCorrectBatch, merge: revertMerge, "nicad-fill": revertNicadFill,
   "map-delete": revertMap, "map-rename": revertMap }`), qui réécrit `before`
   dans `CadSection`/`CadParcelle`/`LimiteSection` ou dans
   `Analysis.correctedData` selon `scope`.
3. La restauration **écrit une nouvelle entrée** (`action: "restore"`,
   `before` = état juste avant la restauration, `after` = état restauré)
   plutôt que de modifier ou supprimer l'entrée ciblée — l'historique reste
   append-only et une restauration est elle-même annulable. L'entrée ciblée
   reçoit seulement `restoredAt`/`restoredBy`.
4. Retourne l'état rafraîchi pour que le client se mette à jour sans recharger
   la page.

Si l'entrée restaurée n'est pas la plus récente pour son `scopeKey`, aucune
fusion n'est tentée : c'est un simple écrasement, signalé par une
confirmation explicite côté client (voir UI) — rattrapable puisque la
restauration crée elle-même une entrée annulable.

## Intégration UI

Composant partagé `CadHistoryPanel` (liste chronologique inversée : résumé +
horodatage + auteur + bouton **Restaurer**), alimenté par :

```
GET /api/cadastre/history?scope=sections&scopeKey=<syscolCommune>
GET /api/cadastre/history?scope=map&scopeKey=<analysisId>
```

- **`/cadastre/sections`** : nouveau bouton "Historique" dans la barre
  d'outils (`src/components/cadastre/SectionsClient.tsx`, à côté du dropdown
  "Lots" existant) ouvre le panneau en liste complète. Le bouton Restaurer
  est masqué/désactivé pour les non-ADMIN, ouvre une confirmation, appelle la
  route de restauration, puis déclenche le rafraîchissement déjà utilisé
  après une mutation.
- **`/map`** : le Ctrl+Z / bouton Annuler existant (`mapHistory`) reste
  inchangé pour l'annulation immédiate en mémoire. Un bouton "Historique"
  additionnel ouvre le même `CadHistoryPanel` (scope `map`, scopeKey =
  analysisId) — utilisable après un rechargement de page, comblant le trou
  actuel.
- Avertissement de restauration non-linéaire : si l'entrée choisie n'est pas
  la plus récente pour son `scopeKey`, la confirmation précise "des actions
  plus récentes existent après ce point — les restaurer écrasera l'état
  actuel".
- Les entrées `scope=sections` apparaissent aussi en lecture seule sur
  `/cadastre/historique` (`src/app/cadastre/historique/page.tsx`), nouvelle
  carte "Modifications sections/parcelles", pour un audit global sans rouvrir
  la carte.

## Gestion des erreurs

- **Atomicité** : capture + mutation + écriture de l'historique dans la même
  transaction — un échec annule tout, la route renvoie une erreur comme
  aujourd'hui.
- **Restauration non-ADMIN** : 403.
- **Restauration redondante** (double clic) : pas bloquant, crée juste une
  entrée `restore` de plus ; le bouton se désactive pendant la requête comme
  les autres actions de la page.
- **Snapshots volumineux** (`nicad-fill` sur une section à beaucoup de
  parcelles) : acceptable, une action reste bornée à une section/un lot, pas
  à la base entière.

## Vérification

Le projet n'a pas d'infrastructure de tests automatisés (pas de fichiers
`*.test.ts`, pas de script `test` dans `package.json`) — la vérification se
fait manuellement, comme le reste du code existant. Pour chaque action
tracée, scénario manuel : *action → vérifier l'entrée dans le panneau
Historique → Restaurer → vérifier que l'état revient exactement à l'avant*,
sur `/cadastre/sections` et `/map`.
