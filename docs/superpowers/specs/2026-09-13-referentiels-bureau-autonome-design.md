# Référentiels administratifs pour le bureau autonome

Date : 2026-09-13
Statut : approuvé (brainstorming), en attente de plan d'implémentation

## Contexte et objectif

Le bureau autonome GeoAino démarre avec une base PostgreSQL/PostGIS **neuve et
vide** (`prisma db push` sur une base fraîche). Or la construction du NICAD
(`assign-nicad-2026.ts` → `getSyscols2026ForPoints`, et en amont
`build-sections.ts` → jointure spatiale sur `cad_communes_2026`) dépend de 4
référentiels administratifs statiques que seule la base web accumule
aujourd'hui, via des scripts one-off (`scripts/load-communes-2026.ts`,
`scripts/load-arrondissements.ts`, `scripts/load-correspondance.ts`,
`scripts/load-etl-verifcad.ts`/`migrate-vericad.ts` pour `cad_communes_2013`) :

| Table | Lignes (base web) | Rôle |
| --- | --- | --- |
| `cad_communes_2026` | 553 | Jointure spatiale résolvant le Syscol — **bloquant** : sans elle, `build-sections.ts` écrit `syscolCommune: null` sur chaque section, et `assign-nicad-2026.ts` ne peut jamais construire de NICAD |
| `cad_communes_2013` | 1647 | Référentiel 2013 (basculement, cartes) |
| `cad_arrondissements` | 127 | Niveau administratif supplémentaire (limites, filtres carte) |
| `cad_correspondance_2013_2026` | 549 | Table de correspondance pour le basculement NICAD 2013→2026 |

**Aucune tâche du plan initial du bureau autonome (2026-09-11) n'a prévu de
charger ces référentiels** — lacune d'origine, découverte en investiguant un
rapport utilisateur : « les sections ne sont pas prises en compte » à
l'import DXF/shapefile sur le bureau autonome. Confirmé par lecture directe du
code (`build-sections.ts:6`, jointure spatiale sur `cad_communes_2026` pour
chaque fragment de section) — pas seulement par déduction.

## Décisions validées (brainstorming)

| Décision | Choix retenu |
| --- | --- |
| Fréquence de mise à jour | **Chargé une fois au premier lancement**, comme le compte admin — pas de synchronisation automatique en cas de mise à jour future des référentiels (nécessiterait un nouveau dump + republication, hors périmètre) |
| Mécanisme d'embarquement | **Dump SQL pré-généré** (`pg_dump --data-only`) au moment du build, exécuté via `psql -f` au premier lancement — rejeté : rejouer les scripts `load-*.ts` (nécessiterait de bundler Prisma Client complet + adapter 3-4 scripts hétérogènes pour un gain nul, la donnée cible étant déjà correcte côté web) |
| Échec au premier lancement | **Bloquant** (dialogue d'erreur + arrêt), cohérent avec le traitement des autres ressources critiques (`pg-portable` manquant échoue déjà ainsi) |
| `limite_section` | **Ne fait PAS partie de ce chargement** — c'est une table QA construite à la demande par l'utilisateur (page « Gestion des sections »), pas un référentiel statique national. Elle reste vide/construite par l'usage normal de l'app, comme aujourd'hui |

## Architecture générale

```mermaid
flowchart TD
    A["desktop/scripts/generer-referentiels.ts<br/>(outillage build, une fois)"] -->|pg_dump --data-only<br/>via pg-portable/bin/pg_dump.exe| B["desktop/vendor/referentiels/referentiels.sql<br/>(~15-20 Mo, gitignore)"]
    B -->|extraResources| C["Installateur"]
    C -->|premier lancement| D{"cad_communes_2026<br/>deja peuplee ?"}
    D -- non --> E["psql -f referentiels.sql<br/>(chargerReferentiels)"]
    D -- oui --> F["skip"]
    E --> F
    F --> G["amorcerCompteAdmin"]
```

Le dump est généré **une fois, au moment du build**, à partir de la base web
déjà peuplée (source de vérité), via le `pg_dump.exe` déjà embarqué dans
`pg-portable` — aucune nouvelle dépendance. Au premier lancement du bureau
autonome, `chargerReferentiels()` (nouvelle fonction, `desktop/src/main.ts`)
vérifie si `cad_communes_2026` est vide et, si oui, rejoue le dump via
`psql -f`. Idempotent par construction (ne s'exécute que si vide), appelée
juste après `creerIndexSpatiaux(clusterPg.port)` et avant `amorcerCompteAdmin`.

## Composants à créer/modifier

| Fichier | Rôle |
| --- | --- |
| `desktop/scripts/generer-referentiels.ts` | Outil de build (une fois, ou à chaque mise à jour manuelle des référentiels) : `pg_dump --data-only` des 4 tables depuis une base source (web) vers `desktop/vendor/referentiels/referentiels.sql` |
| `desktop/vendor/referentiels/referentiels.sql` | Dump généré, gitignoré (comme `pg-portable`/`tesseract-lang` précédemment) |
| `desktop/vendor/referentiels/.gitignore` | `*` / `!.gitignore` (même motif que les autres dossiers vendor) |
| `desktop/electron-builder.yml` | Nouvelle entrée `extraResources` : `desktop/vendor/referentiels` → `referentiels` |
| `desktop/src/main.ts` | Nouvelle fonction `chargerReferentiels(port: number): void`, appelée après `creerIndexSpatiaux(clusterPg.port)` et avant `amorcerCompteAdmin` |
| `docs/BUREAU-AUTONOME.md` | Nouvelle section « Référentiels administratifs » (génération, prérequis de build, limitation : figés à la date du dump, reconstruction des sections déjà créées) |

## Génération du dump

```bash
npx tsx desktop/scripts/generer-referentiels.ts --url "postgresql://postgres:geoaino123@localhost:5437/geoaino_db"
```

Le script exécute, pour chacune des 4 tables (`cad_communes_2013`,
`cad_communes_2026`, `cad_arrondissements`, `cad_correspondance_2013_2026`),
un `pg_dump --data-only --table=<nom> <url>` via le binaire
`desktop/vendor/pg-portable/bin/pg_dump.exe` déjà embarqué, et concatène les
résultats dans `referentiels.sql`. `pg_dump` gère nativement les colonnes
géométrie PostGIS (littéraux WKB) et les séquences (`setval`) — aucun
traitement custom nécessaire, contrairement à `Parcelle.geom` ou
`CadVerification.geom` qui nécessitaient du SQL brut séparé côté application.

## Intégration dans `main.ts`

```typescript
function chargerReferentiels(port: number): void {
  const dejaCharge = executerPsql(port, ["-d", "geoaino", "-tAc", "SELECT count(*) FROM cad_communes_2026"]);
  if (dejaCharge.status !== 0) {
    throw new Error(`Verification des referentiels echouee : ${dejaCharge.stderr?.toString()}`);
  }
  if (Number(dejaCharge.stdout?.toString().trim()) > 0) return; // deja charges

  const cheminDump = path.join(cheminRessources, "referentiels", "referentiels.sql");
  const psql = path.join(cheminRessources, "pg-portable", "bin", "psql.exe");
  const resultat = spawnSync(psql, [
    "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "geoaino",
    "-v", "ON_ERROR_STOP=1", "-f", cheminDump,
  ], { timeout: 60_000 });
  if (resultat.status !== 0) {
    throw new Error(`Chargement des referentiels echoue : ${resultat.stderr?.toString() || resultat.error?.message}`);
  }
}
```

`-v ON_ERROR_STOP=1` : sans ça, `psql -f` continue après une erreur SQL en
cours de script et ne renvoie pas de code de sortie non-nul — masquerait un
dump partiellement corrompu ou une incompatibilité de schéma.

## Gestion d'erreurs et limites assumées

- **`referentiels.sql` manquant ou chargement échoué** → échec bloquant
  (dialogue d'erreur, `app.quit()`), même traitement que `pg-portable`
  manquant — pas de démarrage partiel silencieux qui reproduirait le bug
  initial.
- **Référentiels figés à la date du dump** : toute correction future des
  limites administratives (changement de Syscol, fusion de commune, etc.)
  nécessite de régénérer `referentiels.sql` et de republier l'app. Pas de
  synchronisation automatique (choix explicite, cf. décisions validées).
- **Sections déjà construites sur une installation existante restent
  cassées** : si un opérateur a déjà utilisé « Gestion des sections » avant
  ce correctif, les lignes `limite_section` déjà écrites ont `syscolCommune:
  null` (jointure faite contre une base alors vide) — il faudra reconstruire
  ces sections après la mise à jour de l'app pour qu'elles obtiennent un
  Syscol correct. Pas de migration automatique de ces lignes existantes
  (hors périmètre : nécessiterait de rejouer `build-sections.ts` en arrière-
  plan, complexité non justifiée pour un correctif d'un bug qui vient d'être
  découvert).
- **`limite_section` reste hors de ce chargement** — construite à la demande
  par l'utilisateur, pas un référentiel statique national.

## Tests

- **Manuel** (ajouté à `docs/BUREAU-AUTONOME.md` §5) :
  1. Après premier lancement, vérifier `SELECT count(*) FROM
     cad_communes_2026` > 0 sur la base desktop (`psql` via `pg-portable`).
  2. Importer un DXF/shapefile, construire les sections via « Gestion des
     sections », confirmer que `limite_section.syscolCommune` n'est plus
     `null`.
  3. Confirmer qu'un NICAD complet (Syscol+Section+Parcelle) est bien
     assigné aux parcelles de ce DXF.
- Pas de test automatisé dédié — même convention que `creerIndexSpatiaux`/
  `amorcerCompteAdmin` (logique DB-only, vérifiée manuellement, cohérent
  avec `docs/BUREAU-AUTONOME.md` §5 existant).

## Hors périmètre (explicitement)

- Synchronisation/mise à jour automatique des référentiels après le premier
  lancement.
- Migration automatique des lignes `limite_section` déjà construites avant
  ce correctif (reconstruction manuelle par l'utilisateur).
- Pré-chargement de `limite_section` lui-même (reste construit à la demande).
