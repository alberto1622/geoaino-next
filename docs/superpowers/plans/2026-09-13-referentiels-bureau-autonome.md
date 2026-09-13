# Référentiels administratifs bureau autonome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le bureau autonome GeoAino charge automatiquement, au premier lancement, les 4 référentiels administratifs statiques (`cad_communes_2013`, `cad_communes_2026`, `cad_arrondissements`, `cad_correspondance_2013_2026`) sans lesquels aucun NICAD/section ne peut jamais être assigné aux parcelles importées.

**Architecture:** Un outil de build (`generer-referentiels.ts`) exporte les 4 tables déjà peuplées de la base web via `pg_dump --data-only` vers un fichier `referentiels.sql` embarqué dans l'installateur (comme `pg-portable`). Au premier lancement, `desktop/src/main.ts` rejoue ce dump via `psql -f` si `cad_communes_2026` est vide — même pattern que `synchroniserSchema`/`creerIndexSpatiaux` déjà en place.

**Tech Stack:** `pg_dump`/`psql` (déjà embarqués via `pg-portable`), `node:child_process`, `node:fs` — aucune nouvelle dépendance npm.

**Spec:** [`docs/superpowers/specs/2026-09-13-referentiels-bureau-autonome-design.md`](../specs/2026-09-13-referentiels-bureau-autonome-design.md)

## Global Constraints

- Référentiels chargés **une seule fois**, au premier lancement — pas de synchronisation automatique ultérieure.
- Mécanisme : **dump SQL pré-généré** (`pg_dump --data-only`), jamais les scripts `load-*.ts` existants.
- Échec du chargement (fichier manquant, `psql` en erreur) → **échec bloquant** (dialogue d'erreur, `app.quit()`), jamais un démarrage partiel silencieux.
- `limite_section` reste **hors de ce chargement** — construit à la demande par l'utilisateur, pas un référentiel statique.
- `psql -f` doit toujours être invoqué avec `-v ON_ERROR_STOP=1`.

---

### Task 1: Outil de génération du dump (`desktop/scripts/generer-referentiels.ts`)

**Files:**
- Create: `desktop/scripts/generer-referentiels.ts`

**Interfaces:**
- Produces: le fichier `desktop/vendor/referentiels/referentiels.sql` (consommé par Task 2's `chargerReferentiels`). Aucune fonction exportée — script exécuté directement via `npx tsx`.

`desktop/vendor/` a déjà un `.gitignore` racine (`*` / `!.gitignore`) qui couvre tout sous-dossier, y compris un nouveau `referentiels/` — aucun `.gitignore` supplémentaire à créer.

- [ ] **Step 1: Écrire `desktop/scripts/generer-referentiels.ts`**

```typescript
/**
 * Genere desktop/vendor/referentiels/referentiels.sql -- dump des 4
 * referentiels administratifs statiques (cad_communes_2013, cad_communes_2026,
 * cad_arrondissements, cad_correspondance_2013_2026) depuis une base source
 * (web, deja peuplee) via `pg_dump --data-only`, pour etre rejoue au premier
 * lancement du bureau autonome (cf. docs/superpowers/specs/2026-09-13-
 * referentiels-bureau-autonome-design.md). `pg_dump` gere nativement les
 * colonnes geometrie PostGIS et les sequences (setval) -- aucun traitement
 * custom necessaire.
 *
 * Usage : npx tsx desktop/scripts/generer-referentiels.ts --url <DATABASE_URL>
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TABLES = [
  "cad_communes_2013",
  "cad_communes_2026",
  "cad_arrondissements",
  "cad_correspondance_2013_2026",
];

function lireArgUrl(): string {
  const idx = process.argv.indexOf("--url");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error("Usage : npx tsx desktop/scripts/generer-referentiels.ts --url <DATABASE_URL>");
    process.exit(1);
  }
  return process.argv[idx + 1];
}

const url = lireArgUrl();
const pgDump = path.join(__dirname, "..", "vendor", "pg-portable", "bin", "pg_dump.exe");
const cheminSortie = path.join(__dirname, "..", "vendor", "referentiels", "referentiels.sql");

mkdirSync(path.dirname(cheminSortie), { recursive: true });

const morceaux: string[] = [];
for (const table of TABLES) {
  console.log(`Dump de ${table}...`);
  // maxBuffer eleve : les geometries MultiPolygon (communes/arrondissements)
  // produisent des dumps de plusieurs Mo par table, largement au-dela du
  // 1 Mo par defaut d'execFileSync.
  const sql = execFileSync(pgDump, ["--data-only", `--table=${table}`, url], {
    maxBuffer: 200 * 1024 * 1024,
  }).toString();
  morceaux.push(sql);
}

writeFileSync(cheminSortie, morceaux.join("\n"), "utf8");
console.log(`Ecrit : ${cheminSortie}`);
```

- [ ] **Step 2: Lancer le script contre la base web de dev et vérifier le résultat**

Run:
```bash
npx tsx desktop/scripts/generer-referentiels.ts --url "postgresql://postgres:geoaino123@localhost:5437/geoaino_db"
```

Expected : 4 lignes `Dump de <table>...` puis `Ecrit : .../desktop/vendor/referentiels/referentiels.sql`, code de sortie 0.

- [ ] **Step 3: Vérifier le contenu du dump**

Run:
```bash
grep -c "^COPY\|^INSERT INTO" desktop/vendor/referentiels/referentiels.sql
grep -c "cad_communes_2013\|cad_communes_2026\|cad_arrondissements\|cad_correspondance_2013_2026" desktop/vendor/referentiels/referentiels.sql
```

Expected : au moins 4 occurrences de `COPY`/`INSERT INTO` (une par table), et les 4 noms de table présents dans le fichier. Vérifier aussi la taille : `ls -la desktop/vendor/referentiels/referentiels.sql` doit afficher plusieurs Mo (pas quelques Ko — signe d'un dump vide/tronqué).

- [ ] **Step 4: Vérification TypeScript**

Run: `npx tsc -p desktop/tsconfig.scripts.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 5: Commit**

Le fichier `referentiels.sql` généré est ignoré par `desktop/vendor/.gitignore` — seul le script est commité.

```bash
git add desktop/scripts/generer-referentiels.ts
git commit -m "feat(desktop): outil de generation du dump des referentiels administratifs"
```

---

### Task 2: Chargement au premier lancement (`desktop/src/main.ts` + `desktop/electron-builder.yml`)

**Files:**
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/src/main.ts`

**Interfaces:**
- Consumes: `desktop/vendor/referentiels/referentiels.sql` (Task 1, doit exister localement avant de tester ce Task).
- Produces: aucune interface consommée par une autre tâche — dernière tâche fonctionnelle du plan.

- [ ] **Step 1: Ajouter la ressource dans `desktop/electron-builder.yml`**

Modifier :

```yaml
extraResources:
  - from: desktop/vendor/pg-portable
    to: pg-portable
  - from: .next/standalone
    to: app
```

en :

```yaml
extraResources:
  - from: desktop/vendor/pg-portable
    to: pg-portable
  - from: desktop/vendor/referentiels
    to: referentiels
  - from: .next/standalone
    to: app
```

- [ ] **Step 2: Ajouter `chargerReferentiels` dans `desktop/src/main.ts`**

Insérer la fonction juste après `creerIndexSpatiaux` (après la ligne `}` qui la termine, avant le commentaire JSDoc de `amorcerCompteAdmin`) :

```typescript
// Les 4 referentiels administratifs statiques (cad_communes_2013/2026,
// cad_arrondissements, cad_correspondance_2013_2026) ne sont jamais crees
// par `db push` (ce sont des DONNEES, pas un changement de schema) : sur une
// base neuve, ils sont vides. Consequence reelle constatee : `build-sections.ts`
// resout `syscolCommune` par jointure spatiale sur `cad_communes_2026` --
// contre une table vide, chaque section construite recoit `syscolCommune:
// null`, et `assign-nicad-2026.ts` ne peut alors jamais construire de NICAD
// (cf. docs/superpowers/specs/2026-09-13-referentiels-bureau-autonome-design.md).
// Charge une seule fois (verifie sur `cad_communes_2026`, comme
// `amorcerCompteAdmin` verifie sur `User`) depuis un dump SQL pre-genere
// (`generer-referentiels.ts`) embarque via `extraResources` -- jamais les
// scripts `load-*.ts` web (necessiteraient Prisma Client complet au runtime
// desktop pour un gain nul, la donnee cible etant deja correcte cote web).
function chargerReferentiels(port: number): void {
  const dejaCharge = executerPsql(port, ["-d", "geoaino", "-tAc", "SELECT count(*) FROM cad_communes_2026"]);
  if (dejaCharge.status !== 0) {
    throw new Error(`Verification des referentiels echouee : ${dejaCharge.stderr?.toString()}`);
  }
  if (Number(dejaCharge.stdout?.toString().trim()) > 0) return;

  const cheminDump = path.join(cheminRessources, "referentiels", "referentiels.sql");
  const psql = path.join(cheminRessources, "pg-portable", "bin", "psql.exe");
  // `-v ON_ERROR_STOP=1` : sans ca, `psql -f` continue apres une erreur SQL
  // en cours de script et ne renvoie pas de code de sortie non-nul --
  // masquerait un dump partiellement corrompu ou une incompatibilite de
  // schema plutot que d'echouer bruyamment.
  const resultat = spawnSync(psql, [
    "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "geoaino",
    "-v", "ON_ERROR_STOP=1", "-f", cheminDump,
  ], { timeout: 60_000 });
  if (resultat.status !== 0) {
    throw new Error(`Chargement des referentiels echoue : ${resultat.stderr?.toString() || resultat.error?.message}`);
  }
}
```

- [ ] **Step 3: Appeler `chargerReferentiels` dans `demarrerApplication`**

Modifier :

```typescript
  synchroniserSchema(env);
  creerIndexSpatiaux(clusterPg.port);

  const identifiantsInitiaux = await amorcerCompteAdmin(clusterPg.port);
```

en :

```typescript
  synchroniserSchema(env);
  creerIndexSpatiaux(clusterPg.port);
  chargerReferentiels(clusterPg.port);

  const identifiantsInitiaux = await amorcerCompteAdmin(clusterPg.port);
```

- [ ] **Step 4: Vérification TypeScript**

Run: `npx tsc -p desktop/tsconfig.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 5: Vérification manuelle bout en bout**

Prérequis : `desktop/vendor/referentiels/referentiels.sql` existe (Task 1), `desktop/vendor/pg-portable` assemblé, `desktop/vendor/tesseract-lang` n'est plus nécessaire (module retiré).

1. Mettre de côté `%APPDATA%\GeoAino` s'il existe déjà (renommer, ne pas supprimer) pour repartir d'une base neuve.
2. `npm run build:desktop` (recompile `desktop/dist/main.js` avec le changement).
3. Lancer l'app en mode non empaqueté (`npx electron desktop/dist/main.js`, ou reconstruire l'installateur via `npm run dist:desktop` pour un test complet) et suivre l'activation/premier lancement jusqu'au bout.
4. Une fois l'app démarrée, vérifier directement sur la base desktop :
   ```bash
   "desktop/vendor/pg-portable/bin/psql.exe" -h 127.0.0.1 -p 54329 -U postgres -d geoaino -c "SELECT 'cad_communes_2013' t, count(*) FROM cad_communes_2013 UNION ALL SELECT 'cad_communes_2026', count(*) FROM cad_communes_2026 UNION ALL SELECT 'cad_arrondissements', count(*) FROM cad_arrondissements UNION ALL SELECT 'cad_correspondance_2013_2026', count(*) FROM cad_correspondance_2013_2026;"
   ```
   Expected : les 4 comptes correspondent aux lignes de la base source (`cad_communes_2013` ≈ 1647, `cad_communes_2026` ≈ 553, `cad_arrondissements` ≈ 127, `cad_correspondance_2013_2026` ≈ 549 — les valeurs exactes dépendent de la base source au moment du dump).
5. Relancer l'app une seconde fois → vérifier via les logs/comportement qu'aucune erreur ne survient (le `SELECT count(*)` trouve des lignes, `chargerReferentiels` retourne immédiatement sans rejouer le dump).
6. Importer un DXF/shapefile, construire les sections via « Gestion des sections ». Vérifier directement que `limite_section.syscolCommune` n'est plus `null` :
   ```bash
   "desktop/vendor/pg-portable/bin/psql.exe" -h 127.0.0.1 -p 54329 -U postgres -d geoaino -c "SELECT count(*) FROM limite_section WHERE \"syscolCommune\" IS NULL;"
   ```
   Expected : `0`. Puis confirmer qu'un NICAD complet (Syscol+Section+Parcelle) est assigné aux parcelles de ce DXF — plus de section vide/absente.

- [ ] **Step 6: Commit**

```bash
git add desktop/electron-builder.yml desktop/src/main.ts
git commit -m "feat(desktop): charger les referentiels administratifs au premier lancement"
```

---

### Task 3: Documentation (`docs/BUREAU-AUTONOME.md`)

**Files:**
- Modify: `docs/BUREAU-AUTONOME.md`

**Interfaces:** aucune — tâche documentaire uniquement.

- [ ] **Step 1: Ajouter une section « Référentiels administratifs » après la section « Clé d'activation »**

Insérer, après la fin de la section « Clé d'activation » (juste avant « ### Emplacement des données persistantes ») :

```markdown
### Référentiels administratifs (communes, arrondissements)

La construction du NICAD (Syscol + section) dépend de 4 référentiels
administratifs statiques (`cad_communes_2013`, `cad_communes_2026`,
`cad_arrondissements`, `cad_correspondance_2013_2026`) — sans eux, aucune
section ne peut être résolue par jointure spatiale (`build-sections.ts`),
et aucun NICAD n'est jamais assigné aux parcelles importées.

Ces référentiels sont chargés **une seule fois**, au premier lancement,
depuis un dump SQL pré-généré au moment du build :

```bash
npx tsx desktop/scripts/generer-referentiels.ts --url "postgresql://postgres:PASSWORD@HOST:PORT/DB_WEB"
```

Résultat attendu : `desktop/vendor/referentiels/referentiels.sql` (plusieurs
Mo). **À régénérer avant chaque build de distribution** si la base web a
reçu des corrections de référentiels depuis le dernier dump — sinon
l'installateur embarque des données obsolètes.

**Limitations assumées :**
- Référentiels **figés à la date du dump** : aucune synchronisation
  automatique ultérieure. Une correction des limites administratives
  nécessite de régénérer le dump et de republier l'app.
- Une installation qui a déjà utilisé « Gestion des sections » **avant**
  ce correctif garde des sections avec `syscolCommune: null` — il faut les
  reconstruire après la mise à jour de l'app pour qu'elles obtiennent un
  Syscol correct.
- `limite_section` (les limites de section elles-mêmes) reste **hors** de
  ce chargement — construit à la demande par l'utilisateur via « Gestion
  des sections », pas un référentiel statique national.
```

- [ ] **Step 2: Ajouter le prérequis dans la section 2 (« Prérequis avant un premier build »)**

Ajouter, après le paragraphe sur `desktop/vendor/pg-portable` :

```markdown
Les référentiels administratifs (voir section dédiée plus haut) doivent
également être générés avant un build de distribution :

```bash
npx tsx desktop/scripts/generer-referentiels.ts --url "postgresql://postgres:PASSWORD@HOST:PORT/DB_WEB"
```
```

- [ ] **Step 3: Relire le document entier pour cohérence**

Vérifier que la section 5 (« Vérification manuelle ») mentionne bien de vérifier les référentiels lors d'un premier lancement — ajouter, dans le point numéroté sur le premier lancement, une ligne :

```markdown
   - `SELECT count(*) FROM cad_communes_2026` sur la base desktop retourne
     un nombre > 0 (référentiels administratifs chargés).
```

- [ ] **Step 4: Commit**

```bash
git add docs/BUREAU-AUTONOME.md
git commit -m "docs(desktop): documenter le chargement des referentiels administratifs"
```
