# Bureau autonome (Electron + PostgreSQL/PostGIS embarqué) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Packager geoaino-next en application Windows autonome (Electron), avec un vrai PostgreSQL 16 + PostGIS local (portable, sans installateur ni droits admin) et le serveur Next.js existant en mode `standalone`, sans réécrire le code applicatif ni le SQL PostGIS.

**Architecture:** Trois processus dans une app Electron : (1) le process principal orchestre le cycle de vie, (2) un cluster PostgreSQL/PostGIS local (binaires portables embarqués, `%APPDATA%\GeoAino\pgdata`) exposé uniquement sur `127.0.0.1`, (3) le serveur Next.js `standalone` en sous-processus Node, servi à une `BrowserWindow` Electron qui joue le rôle de navigateur.

**Tech Stack:** Electron, electron-builder (NSIS), PostgreSQL 16 (binaires portables EDB), PostGIS (bundle Windows OSGeo), Next.js 16 `output: standalone`, Prisma 5, TypeScript, PowerShell (scripts d'assemblage).

**Spec:** `docs/superpowers/specs/2026-09-11-bureau-autonome-design.md`

## Global Constraints

- Cible **Windows x64 uniquement** (pas de macOS/Linux dans ce plan).
- **Mono-poste** : aucune synchronisation réseau, aucune gestion de concurrence multi-client sur le même Postgres.
- **Aucune modification du SQL applicatif ni du schéma métier** — seul le SQL touchant strictement l'infrastructure (création de base/extension, migrations) est concerné.
- **Aucun changement de comportement en mode web** : toute variable d'environnement ou chemin ajouté pour le bureau autonome doit être optionnel et sans effet quand absent (le serveur web continue de tourner à l'identique).
- Pas d'auto-update en ligne, pas de signature de code, pas de licence/activation — hors scope (cf. spec).
- Style du projet : commentaires en français, uniquement pour le « pourquoi » non évident ; pas de commentaires WHAT.
- Validation systématique par tâche : `npx tsc --noEmit` (racine) et/ou `npx tsc -p desktop/tsconfig.json --noEmit` (Electron) selon les fichiers touchés, `npx eslint <fichiers touchés>`, et le script de test dédié à la tâche.

---

## Task 1: Assembler le bundle PostgreSQL 16 + PostGIS portable pour Windows

C'est le risque le plus incertain du projet (cf. spec, « Risques résiduels ») : le valider en premier, avant d'investir dans l'orchestration Electron.

**Faits vérifiés (recherche effectuée pendant le brainstorming) :**
- EDB distribue PostgreSQL pour Windows en **zip sans installateur** : https://www.enterprisedb.com/download-postgresql-binaries (version actuelle utilisée par le projet : PostgreSQL **16**, ex. `postgresql-16.15-1-windows-x64-binaries.zip`).
- PostGIS distribue un **zip de binaires** (pas seulement un installateur) pour PostgreSQL 16, 64-bit, sur https://download.osgeo.org/postgis/windows/pg16/ (ou via la page https://postgis.net/documentation/getting_started/install_windows/released_versions/) — « les fichiers .zip sont juste les binaires à copier dans l'installation PostgreSQL, puis à activer dans chaque base ». Le projet utilise PostGIS 3.4 en production (`docker-compose.yml` : `postgis/postgis:16-3.4`) ; une version PostGIS plus récente compatible PG16 (ex. 3.6.x) convient aussi — le code applicatif n'utilise que des fonctions `ST_*`/GiST stables, pas de fonctionnalité liée à un correctif mineur précis.

**Files:**
- Create: `desktop/scripts/assemble-pg-portable.ps1`
- Create: `desktop/vendor/.gitignore`
- Modify: `.gitignore` (racine, si `desktop/vendor/` doit aussi y être exclu — cf. Step 4)

**Interfaces:**
- Produces: un dossier `desktop/vendor/pg-portable/` contenant `bin/initdb.exe`, `bin/pg_ctl.exe`, `bin/postgres.exe`, `bin/psql.exe`, `bin/pg_isready.exe`, `lib/postgis-3.*.dll` (ou équivalent), `share/extension/postgis*.control` — structure consommée par Task 2 (`postgres-manager.ts`) et Task 10 (`electron-builder.yml`, `extraResources`).

- [ ] **Step 1 : Téléchargements manuels**

  Depuis un navigateur (ces pages exigent une interaction humaine, pas d'automatisation fiable) :
  1. https://www.enterprisedb.com/download-postgresql-binaries → PostgreSQL **16.x**, Windows x86-64, zip « binaries ».
  2. https://download.osgeo.org/postgis/windows/pg16/ → le zip (pas le `.exe`) le plus récent pour PostgreSQL 16, 64-bit.

  Noter les deux chemins locaux téléchargés (ex. `C:\Downloads\postgresql-16.15-1-windows-x64-binaries.zip` et `C:\Downloads\postgis-bundle-pg16x64-....zip`).

- [ ] **Step 2 : Écrire le script d'assemblage**

  ```powershell
  # desktop/scripts/assemble-pg-portable.ps1
  # Assemble un PostgreSQL 16 + PostGIS portable (zips EDB + PostGIS, sans
  # installateur) dans desktop/vendor/pg-portable/, pour etre embarque tel
  # quel par electron-builder (cf. Task 10, extraResources).
  #
  # Prerequis : telecharger manuellement (pages avec interaction navigateur) :
  #   - PostgreSQL 16.x Windows x86-64 "binaries" zip :
  #     https://www.enterprisedb.com/download-postgresql-binaries
  #   - PostGIS zip (pas l'installateur .exe) pour PostgreSQL 16, 64-bit :
  #     https://download.osgeo.org/postgis/windows/pg16/
  #
  # Usage :
  #   .\assemble-pg-portable.ps1 -PgZip <chemin> -PostgisZip <chemin>

  param(
      [Parameter(Mandatory=$true)][string]$PgZip,
      [Parameter(Mandatory=$true)][string]$PostgisZip
  )

  $ErrorActionPreference = "Stop"
  $dest = Join-Path $PSScriptRoot "..\vendor\pg-portable"

  if (Test-Path $dest) {
      Remove-Item $dest -Recurse -Force
  }
  New-Item -ItemType Directory -Path $dest | Out-Null

  Write-Host "Extraction de PostgreSQL..."
  Expand-Archive -Path $PgZip -DestinationPath $dest -Force
  # L'archive EDB extrait un dossier "pgsql" a la racine : on remonte son contenu.
  $pgsql = Join-Path $dest "pgsql"
  if (Test-Path $pgsql) {
      Get-ChildItem $pgsql | Move-Item -Destination $dest -Force
      Remove-Item $pgsql -Recurse -Force
  }

  Write-Host "Extraction de PostGIS..."
  $postgisTmp = Join-Path $dest "_postgis_tmp"
  Expand-Archive -Path $PostgisZip -DestinationPath $postgisTmp -Force
  # Le zip PostGIS a la meme structure bin/lib/share qu'une installation
  # PostgreSQL : on fusionne son contenu dans l'arbre deja extrait.
  Copy-Item -Path (Join-Path $postgisTmp "*") -Destination $dest -Recurse -Force
  Remove-Item $postgisTmp -Recurse -Force

  Write-Host "Verification : demarrage d'un cluster de test..."
  $testData = Join-Path $env:TEMP "geoaino-pg-portable-test"
  if (Test-Path $testData) { Remove-Item $testData -Recurse -Force }

  & (Join-Path $dest "bin\initdb.exe") -D $testData -U postgres -A trust -E UTF8 | Out-Null
  & (Join-Path $dest "bin\pg_ctl.exe") -D $testData -l (Join-Path $testData "log.txt") -o "-p 55432 -c listen_addresses=127.0.0.1" start | Out-Null
  Start-Sleep -Seconds 2
  & (Join-Path $dest "bin\psql.exe") -h 127.0.0.1 -p 55432 -U postgres -c "CREATE EXTENSION postgis; SELECT PostGIS_Version();"
  $ok = $LASTEXITCODE -eq 0
  & (Join-Path $dest "bin\pg_ctl.exe") -D $testData -m fast stop | Out-Null
  Start-Sleep -Seconds 1
  Remove-Item $testData -Recurse -Force

  if (-not $ok) {
      throw "Echec : CREATE EXTENSION postgis a echoue sur le bundle assemble."
  }
  Write-Host "OK : $dest contient un PostgreSQL 16 + PostGIS fonctionnel."
  ```

- [ ] **Step 3 : Exécuter le script**

  ```
  powershell -ExecutionPolicy Bypass -File desktop\scripts\assemble-pg-portable.ps1 -PgZip "C:\Downloads\postgresql-16.15-1-windows-x64-binaries.zip" -PostgisZip "C:\Downloads\<zip-postgis-pg16>.zip"
  ```

  Attendu : le script se termine sur `OK : ... contient un PostgreSQL 16 + PostGIS fonctionnel.` — si `CREATE EXTENSION postgis` échoue, la structure fusionnée est incorrecte (vérifier que le zip PostGIS téléchargé est bien la variante « zip », pas seulement le `.exe` StackBuilder) : corriger avant de continuer, ce point bloque tout le reste du plan.

- [ ] **Step 4 : Exclure le bundle du contrôle de version**

  `desktop/vendor/pg-portable/` fait plusieurs centaines de Mo — ne jamais le committer.

  ```
  # desktop/vendor/.gitignore
  *
  !.gitignore
  ```

- [ ] **Step 5 : Commit**

  ```bash
  git add desktop/scripts/assemble-pg-portable.ps1 desktop/vendor/.gitignore
  git commit -m "build(desktop): script d'assemblage du bundle PostgreSQL 16 + PostGIS portable"
  ```

---

## Task 2: Scaffold `desktop/` + cycle de vie du cluster Postgres local

**Files:**
- Modify: `tsconfig.json` (racine) — exclure `desktop/`
- Modify: `package.json` — devDependencies `electron`, `electron-builder` ; champ `"main"` ; script `build:desktop`
- Create: `desktop/tsconfig.json`
- Create: `desktop/src/port-utils.ts`
- Create: `desktop/src/postgres-manager.ts`
- Test: `desktop/scripts/test-postgres-manager.ts`

**Interfaces:**
- Produces (`port-utils.ts`) : `portLibre(port: number): Promise<boolean>`, `trouverPortLibre(candidats: number[]): Promise<number>` — réutilisés par `postgres-manager.ts` (ce fichier) et par `desktop/src/main.ts` (Task 9, pour le port du serveur Next).
- Produces (`postgres-manager.ts`) : `type ClusterPostgres = { port: number; arreter: () => Promise<void> }`, `demarrerPostgresPortable(options: { binDir: string; dataDir: string; candidatsPort: number[] }): Promise<ClusterPostgres>` — consommé par Task 9 (`main.ts`).

- [ ] **Step 1 : Isoler `desktop/` du build TypeScript principal**

  Dans `tsconfig.json` (racine), ajouter `"desktop"` à `exclude` :

  ```json
  "exclude": ["node_modules", "desktop"]
  ```

  (Le sous-projet Electron a ses propres réglages `module`/`lib` — cf. Step 2 — incompatibles avec `moduleResolution: "bundler"` du projet Next ; sans cette exclusion, `npx tsc --noEmit` à la racine tenterait de typer `desktop/src/*.ts` avec le mauvais jeu de types.)

- [ ] **Step 2 : Config TypeScript dédiée**

  ```json
  // desktop/tsconfig.json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "CommonJS",
      "moduleResolution": "node",
      "outDir": "./dist",
      "rootDir": "./src",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "resolveJsonModule": true,
      "types": ["node", "electron"]
    },
    "include": ["src/**/*.ts"]
  }
  ```

- [ ] **Step 3 : Installer les dépendances Electron**

  ```
  bun add -d electron electron-builder
  ```

- [ ] **Step 4 : Déclarer le point d'entrée et le script de build**

  Dans `package.json` :

  ```json
  "main": "desktop/dist/main.js",
  "scripts": {
    "build:desktop": "tsc -p desktop/tsconfig.json"
  }
  ```

  (`"main"` n'affecte que ce qui fait `require(package.json.main)` — Electron, quand on lance `electron .` — et n'a aucun effet sur `next dev`/`next build`.)

- [ ] **Step 5 : `port-utils.ts`**

  ```typescript
  // desktop/src/port-utils.ts
  import { createServer } from "node:net";

  /** Teste si un port TCP local est libre en tentant d'y écouter brièvement. */
  export function portLibre(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const serveur = createServer();
      serveur.once("error", () => resolve(false));
      serveur.once("listening", () => serveur.close(() => resolve(true)));
      serveur.listen(port, "127.0.0.1");
    });
  }

  export async function trouverPortLibre(candidats: number[]): Promise<number> {
    for (const port of candidats) {
      if (await portLibre(port)) return port;
    }
    throw new Error(
      `Aucun port libre parmi ${candidats.join(", ")} — un autre processus local occupe toute la plage.`,
    );
  }
  ```

- [ ] **Step 6 : `postgres-manager.ts`**

  ```typescript
  // desktop/src/postgres-manager.ts
  import { spawnSync } from "node:child_process";
  import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
  import path from "node:path";
  import { trouverPortLibre } from "./port-utils";

  export type ClusterPostgres = {
    port: number;
    arreter: () => Promise<void>;
  };

  /**
   * Un `postmaster.pid` present alors qu'aucun process n'ecoute plus dessus
   * (fermeture forcee precedente, crash) fait echouer `pg_ctl start` avec un
   * message trompeur (« un autre serveur tourne peut-etre »). On le detecte
   * en relisant le PID qu'il contient et en verifiant qu'aucun process
   * Windows ne le porte encore.
   */
  function nettoyerVerrouOrphelin(dataDir: string): void {
    const lockfile = path.join(dataDir, "postmaster.pid");
    if (!existsSync(lockfile)) return;
    const pid = Number(readFileSync(lockfile, "utf8").split("\n")[0]);
    if (!Number.isFinite(pid)) return;
    const tasklist = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
    const processVivant = tasklist.stdout?.toString().includes(String(pid));
    if (!processVivant) rmSync(lockfile, { force: true });
  }

  async function attendrePret(binDir: string, port: number, delaiMaxMs = 15_000): Promise<void> {
    const pgIsReady = path.join(binDir, "pg_isready.exe");
    const debut = Date.now();
    while (Date.now() - debut < delaiMaxMs) {
      const res = spawnSync(pgIsReady, ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"]);
      if (res.status === 0) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`PostgreSQL local n'a pas repondu dans les ${delaiMaxMs}ms suivant son demarrage.`);
  }

  /**
   * Demarre (en l'initialisant si besoin) un cluster PostgreSQL/PostGIS
   * portable local, ecoutant uniquement sur 127.0.0.1.
   */
  export async function demarrerPostgresPortable(options: {
    binDir: string;
    dataDir: string;
    candidatsPort: number[];
  }): Promise<ClusterPostgres> {
    const { binDir, dataDir, candidatsPort } = options;
    const initdb = path.join(binDir, "initdb.exe");
    const pgCtl = path.join(binDir, "pg_ctl.exe");

    if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
      mkdirSync(dataDir, { recursive: true });
      const init = spawnSync(initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8"]);
      if (init.status !== 0) {
        throw new Error(`initdb a echoue : ${init.stderr?.toString()}`);
      }
    }

    nettoyerVerrouOrphelin(dataDir);
    const port = await trouverPortLibre(candidatsPort);

    const start = spawnSync(pgCtl, [
      "-D", dataDir,
      "-l", path.join(dataDir, "server.log"),
      "-o", `-p ${port} -c listen_addresses=127.0.0.1`,
      "start",
    ]);
    if (start.status !== 0) {
      throw new Error(`pg_ctl start a echoue : ${start.stderr?.toString() || start.stdout?.toString()}`);
    }
    await attendrePret(binDir, port);

    return {
      port,
      arreter: async () => {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "stop"]);
      },
    };
  }
  ```

- [ ] **Step 7 : Script de test**

  ```typescript
  // desktop/scripts/test-postgres-manager.ts
  //
  // Necessite un bundle assemble par assemble-pg-portable.ps1 (Task 1) ;
  // ignore sinon, comme les tests dependant d'une ressource externe
  // optionnelle dans scripts/test-verif.ts.
  //
  // Usage : npx tsx desktop/scripts/test-postgres-manager.ts
  import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import path from "node:path";
  import { spawnSync } from "node:child_process";
  import { demarrerPostgresPortable } from "../src/postgres-manager";

  let ok = 0;
  let ko = 0;
  function check(nom: string, condition: boolean, detail?: string) {
    if (condition) {
      ok++;
      console.log(`  ✓ ${nom}`);
    } else {
      ko++;
      console.error(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`);
    }
  }

  async function main() {
    const binDir = path.resolve(__dirname, "../vendor/pg-portable/bin");
    if (!existsSync(binDir)) {
      console.log("(desktop/vendor/pg-portable absent — executer assemble-pg-portable.ps1 d'abord ; test ignore)");
      return;
    }

    const candidatsPort = [54329, 54330, 54331];
    const dataDir = mkdtempSync(path.join(tmpdir(), "geoaino-pg-test-"));
    const psql = path.join(binDir, "psql.exe");

    console.log("\n[1] Demarrage a froid");
    const cluster = await demarrerPostgresPortable({ binDir, dataDir, candidatsPort });
    check("un port est retenu", candidatsPort.includes(cluster.port), String(cluster.port));

    const req = spawnSync(psql, ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", "postgres", "-c", "SELECT 1;"]);
    check("le cluster repond a une requete", req.status === 0, req.stderr?.toString());

    console.log("\n[2] Recuperation d'un verrou orphelin (process tue de force)");
    const pidFile = path.join(dataDir, "postmaster.pid");
    const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
    spawnSync("taskkill", ["/PID", String(pid), "/F"]);
    await new Promise((r) => setTimeout(r, 500));

    let erreurRedemarrage: unknown = null;
    let clusterApresCrash: Awaited<ReturnType<typeof demarrerPostgresPortable>> | null = null;
    try {
      clusterApresCrash = await demarrerPostgresPortable({ binDir, dataDir, candidatsPort });
    } catch (e) {
      erreurRedemarrage = e;
    }
    check(
      "redemarrage apres verrou orphelin sans erreur",
      erreurRedemarrage === null,
      erreurRedemarrage instanceof Error ? erreurRedemarrage.message : String(erreurRedemarrage),
    );

    if (clusterApresCrash) await clusterApresCrash.arreter();
    rmSync(dataDir, { recursive: true, force: true });

    console.log(`\n${ok} assertion(s) OK, ${ko} en echec.`);
    process.exit(ko === 0 ? 0 : 1);
  }

  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  ```

- [ ] **Step 8 : Valider**

  ```
  npx tsc -p desktop/tsconfig.json --noEmit
  npx eslint desktop/src desktop/scripts
  npx tsc --noEmit
  npx tsx desktop/scripts/test-postgres-manager.ts
  ```

  Attendu : les deux `tsc` passent sans erreur ; le test affiche les deux assertions `✓` si `desktop/vendor/pg-portable` existe (Task 1 faite), ou le message « bundle absent » sinon.

- [ ] **Step 9 : Commit**

  ```bash
  git add tsconfig.json package.json bun.lock desktop/tsconfig.json desktop/src/port-utils.ts desktop/src/postgres-manager.ts desktop/scripts/test-postgres-manager.ts
  git commit -m "feat(desktop): cycle de vie d'un cluster PostgreSQL/PostGIS local (initdb/pg_ctl, port libre, verrou orphelin)"
  ```

---

## Task 3: Next.js en mode `standalone` + dépendances OCR tracées

**Files:**
- Modify: `next.config.ts`
- Create: `scripts/copy-standalone-assets.mjs`
- Modify: `package.json` — script `build:standalone`

**Interfaces:**
- Produces : `.next/standalone/server.js` prêt à être lancé par `node server.js` (avec `PORT`/`DATABASE_URL`/... en env), servant `public/` et `.next/static` — consommé par Task 9 (`next-server.ts`) et Task 10 (`electron-builder.yml`, source de la ressource `app/`).

- [ ] **Step 1 : Activer le mode standalone et le traçage explicite**

  ```typescript
  // next.config.ts
  import type { NextConfig } from "next";

  const nextConfig: NextConfig = {
    output: "standalone",
    serverExternalPackages: [
      "shapefile",
      "jszip",
      "proj4",
      "pdf-lib",
      "pdfjs-dist",
      "tesseract.js",
      "@napi-rs/canvas",
    ],
    // Le module de verification de bornes charge pdfjs-dist/tesseract.js/
    // @napi-rs/canvas via un import() a specificateur VARIABLE (cf. ocr.ts,
    // pdfTableauTexte.ts) — delibere pour que leur absence soit toleree en
    // web. Consequence : le tracage de fichiers de `output: standalone` ne
    // les detecte pas par analyse statique et les omettrait du bundle. Sur
    // le bureau autonome, ces paquets doivent reellement fonctionner
    // (parite complete) : on les inclut donc explicitement.
    outputFileTracingIncludes: {
      "/api/cadastre/verif/**": [
        "./node_modules/pdfjs-dist/**/*",
        "./node_modules/tesseract.js/**/*",
        "./node_modules/tesseract.js-core/**/*",
        "./node_modules/@napi-rs/canvas/**/*",
        "./node_modules/@napi-rs/canvas-win32-x64-msvc/**/*",
      ],
    },
    experimental: {
      serverActions: { bodySizeLimit: "500mb" },
    },
  };

  export default nextConfig;
  ```

- [ ] **Step 2 : Script de copie des assets statiques**

  `output: standalone` ne copie pas `public/` ni `.next/static` dans `.next/standalone` (limitation connue de Next.js) — sans ça, le serveur standalone démarre mais sert des pages sans styles/assets.

  ```javascript
  // scripts/copy-standalone-assets.mjs
  //
  // `next build` (output: standalone) ne copie ni public/ ni .next/static
  // dans .next/standalone : a faire manuellement apres chaque build,
  // sinon le serveur standalone demarre mais sert des pages cassees.
  import { cpSync, existsSync } from "node:fs";

  if (!existsSync(".next/standalone")) {
    console.error("./.next/standalone est absent — lancez `next build` avant ce script.");
    process.exit(1);
  }

  cpSync("public", ".next/standalone/public", { recursive: true });
  cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  console.log("OK : public/ et .next/static copies dans .next/standalone/.");
  ```

- [ ] **Step 3 : Script npm**

  ```json
  "scripts": {
    "build:standalone": "next build && node scripts/copy-standalone-assets.mjs"
  }
  ```

- [ ] **Step 4 : Construire et vérifier**

  ```
  npm run build:standalone
  ```

  Puis vérifier que les dépendances OCR sont bien présentes (le risque identifié dans la spec) :

  ```
  ls .next/standalone/node_modules/pdfjs-dist
  ls .next/standalone/node_modules/tesseract.js
  ls .next/standalone/node_modules/@napi-rs/canvas-win32-x64-msvc
  ```

  Les trois doivent exister. Si l'un est absent, revoir les globs `outputFileTracingIncludes` (chemin de route ou glob de fichier incorrect) avant de continuer.

- [ ] **Step 5 : Smoke test du serveur standalone**

  ```
  set PORT=4173&& set DATABASE_URL=postgresql://invalid&& node .next/standalone/server.js
  ```

  Dans un autre terminal :

  ```
  curl -i http://127.0.0.1:4173/login
  ```

  Attendu : réponse HTTP 200 (la page de login ne dépend pas de la base). Arrêter le serveur (Ctrl+C) après vérification — `DATABASE_URL` invalide est volontaire ici, seul le fait que le serveur HTTP démarre et sert une page est testé à ce stade ; la connexion réelle à la base est couverte par Task 9.

- [ ] **Step 6 : Commit**

  ```bash
  git add next.config.ts scripts/copy-standalone-assets.mjs package.json
  git commit -m "build: mode standalone Next.js + tracage explicite des dependances OCR optionnelles"
  ```

---

## Task 4: Vérification du moteur Prisma natif Windows

**Constat vérifié pendant le brainstorming** : le schéma actuel n'a **aucun** `binaryTargets` explicite (`generator client { provider = "prisma-client-js"; previewFeatures = [...] }`) et `npx prisma generate`, exécuté sur cette machine de dev (Windows), produit déjà `node_modules/.prisma/client/query_engine-windows.dll.node`. Prisma génère par défaut le moteur natif de la machine qui exécute `generate` — tant que le build du bureau autonome est fait sur/pour Windows, **aucun changement de schéma n'est nécessaire**. Un `binaryTargets` explicite (ex. `["native", "windows"]`) ne serait requis que pour une CI de build cross-plateforme (ex. builder l'installateur Windows depuis un runner Linux) — hors scope de ce plan (cf. spec, cible Windows, empaquetage manuel).

**Files:**
- Modify: `prisma/schema.prisma:1-4` (commentaire uniquement, aucun changement fonctionnel)

**Interfaces:** aucune (vérification).

- [ ] **Step 1 : Régénérer et vérifier**

  ```
  npx prisma generate
  ls node_modules/.prisma/client | grep query_engine-windows
  ```

  Attendu : `query_engine-windows.dll.node` listé.

- [ ] **Step 2 : Documenter la décision dans le schéma**

  ```prisma
  // desktop : `prisma generate` cible nativement la machine qui l'execute.
  // Le bureau autonome est construit sur/pour Windows (cf. docs/superpowers/
  // specs/2026-09-11-bureau-autonome-design.md) : aucun `binaryTargets`
  // explicite n'est necessaire tant que le build reste natif. A revoir si
  // une CI cross-plateforme est introduite un jour.
  generator client {
    provider        = "prisma-client-js"
    previewFeatures = ["postgresqlExtensions"]
  }
  ```

- [ ] **Step 3 : Valider**

  ```
  npx tsc --noEmit
  ```

- [ ] **Step 4 : Commit**

  ```bash
  git add prisma/schema.prisma
  git commit -m "docs(prisma): documenter pourquoi aucun binaryTargets explicite n'est requis pour le bureau autonome"
  ```

---

## Task 5: OCR hors-ligne — données de langue tesseract locales

**Faits vérifiés en lisant le code source installé de `tesseract.js@7`** :
- Le *worker* et le *core* wasm sont déjà chargés localement sur Node (`require('tesseract.js-core/...')`, `worker-script/node/index.js`) — **aucun problème** pour eux.
- Seules les données de langue (`eng.traineddata`) sont, par défaut, récupérées sur un CDN (`https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz` pour le mode `LSTM_ONLY` utilisé par `Tesseract.recognize()`, celui qu'appelle `ocr.ts`), sauf si l'option `langPath` pointe vers un dossier local (`tesseract.js/src/worker-script/index.js`) — ce fichier est alors lu directement via le système de fichiers, sans réseau.

**Files:**
- Create: `desktop/vendor/tesseract-lang/.gitignore`
- Modify: `src/lib/cadastre/verif/ocr.ts:77-85` (fonction `reconnaitreImage`)

**Interfaces:**
- Consumes: rien de nouveau côté signatures publiques.
- Produces: `reconnaitreImage` continue d'exposer la même signature `(tesseract: any, image: Buffer): Promise<string>` — le comportement change uniquement si la variable d'environnement `GEOAINO_TESSERACT_LANG_PATH` est présente (mode bureau autonome). `desktop/vendor/tesseract-lang/eng.traineddata.gz` — consommé par Task 7 (`runtime-env.ts`, pré-amorçage du cache) et Task 10 (`electron-builder.yml`, ressource `tesseract-lang`).

- [ ] **Step 1 : Télécharger les données de langue**

  ```
  curl -L -o desktop/vendor/tesseract-lang/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz
  ```

  (Créer le dossier `desktop/vendor/tesseract-lang/` s'il n'existe pas.)

- [ ] **Step 2 : Exclure du contrôle de version**

  ```
  # desktop/vendor/tesseract-lang/.gitignore
  *
  !.gitignore
  ```

- [ ] **Step 3 : Rendre `langPath` configurable dans `ocr.ts`**

  ```typescript
  // src/lib/cadastre/verif/ocr.ts — ajouter pres des autres constantes
  /**
   * Chemin local des donnees de langue tesseract (eng.traineddata.gz),
   * fourni par le process principal Electron sur le bureau autonome (cf.
   * desktop/src/runtime-env.ts). Absent en web : comportement inchange,
   * tesseract.js recupere la donnee sur son CDN par defaut.
   */
  const CHEMIN_LANGUE_OCR = process.env.GEOAINO_TESSERACT_LANG_PATH;
  ```

  Puis modifier `reconnaitreImage` :

  ```typescript
  async function reconnaitreImage(
    tesseract: any,
    image: Buffer,
  ): Promise<string> {
    const { data } = await tesseract.recognize(image, "eng", {
      tessedit_char_whitelist: LISTE_BLANCHE,
      ...(CHEMIN_LANGUE_OCR ? { langPath: CHEMIN_LANGUE_OCR, cachePath: CHEMIN_LANGUE_OCR } : {}),
    });
    return nettoyerTexteOcr(data?.text ?? "");
  }
  ```

- [ ] **Step 4 : Test — l'OCR fonctionne avec `langPath` local**

  Ajouter à `scripts/test-verif.ts`, dans `testOcrImage` (ou juste après, comme cas séparé) :

  ```typescript
  // --- 13. OCR image avec langPath local (bureau autonome) -----------------

  /**
   * Verifie que passer GEOAINO_TESSERACT_LANG_PATH fait toujours fonctionner
   * le pipeline (chemin emprunte par le bureau autonome, cf. ocr.ts). Ne
   * prouve pas l'absence de reseau (hors de portee d'un test unitaire sans
   * mock reseau) — la verification hors-ligne reelle se fait manuellement
   * sur l'app empaquetee (cf. Task 11, checklist de desinstallation/tests).
   */
  async function testOcrImageLangPathLocal() {
    console.log("\n[13] Import image directe — langPath local (desktop)");

    const cheminLangue = path.resolve(__dirname, "../desktop/vendor/tesseract-lang");
    if (!existsSync(path.join(cheminLangue, "eng.traineddata.gz"))) {
      console.log("  (desktop/vendor/tesseract-lang absent — executer Task 5, Step 1 ; test ignore)");
      return;
    }

    const ancien = process.env.GEOAINO_TESSERACT_LANG_PATH;
    process.env.GEOAINO_TESSERACT_LANG_PATH = cheminLangue;
    try {
      const canvas = createCanvas(800, 100);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 800, 100);
      ctx.fillStyle = "#000000";
      ctx.font = "28px sans-serif";
      ctx.fillText("B1 500000.0000 1600100.0000", 20, 50);
      const png = canvas.toBuffer("image/png");

      let erreur: unknown = null;
      try {
        await ocrImageCoordonnees(png);
      } catch (e) {
        erreur = e;
      }
      check(
        "le pipeline fonctionne avec un langPath local",
        erreur === null,
        erreur instanceof Error ? erreur.message : String(erreur),
      );
    } finally {
      process.env.GEOAINO_TESSERACT_LANG_PATH = ancien;
    }
  }
  ```

  Ajouter les imports nécessaires en tête de `scripts/test-verif.ts` (`import path from "node:path";`, `import { existsSync } from "node:fs";` — `path` et `existsSync` ne sont probablement pas déjà importés dans ce fichier, vérifier avant d'ajouter pour éviter un doublon) et l'appel `await testOcrImageLangPathLocal();` dans `main()`, juste après `await testOcrImage();`.

- [ ] **Step 5 : Valider**

  ```
  npx tsc --noEmit
  npx eslint src/lib/cadastre/verif/ocr.ts scripts/test-verif.ts
  npm run test:verif
  ```

  Attendu : le nouveau cas `[13]` passe (ou s'affiche comme ignoré si Step 1 n'a pas été fait dans cet environnement de test) ; tous les autres cas restent verts.

- [ ] **Step 6 : Commit**

  ```bash
  git add src/lib/cadastre/verif/ocr.ts scripts/test-verif.ts desktop/vendor/tesseract-lang/.gitignore
  git commit -m "feat(ocr): langPath tesseract configurable (GEOAINO_TESSERACT_LANG_PATH) pour un fonctionnement hors-ligne"
  ```

---

## Task 6: Dégradation propre de la fonctionnalité IA hors-ligne

**Files:**
- Modify: `src/lib/llm.ts`
- Modify: `src/app/api/ai/chat/route.ts:1-8, 86-99`
- Create: `scripts/test-llm-offline.ts`
- Modify: `package.json` — script `test:llm`

**Interfaces:**
- Produces (`llm.ts`) : `export class LLMIndisponibleError extends Error`, `export function estErreurReseau(err: unknown): boolean` — consommés par `src/app/api/ai/chat/route.ts` (ce fichier) pour distinguer une panne réseau d'une autre erreur.

- [ ] **Step 1 : Détecter les erreurs réseau et les typer**

  ```typescript
  // src/lib/llm.ts — ajouter apres les imports existants
  export class LLMIndisponibleError extends Error {
    constructor() {
      super("Fonctionnalite IA indisponible : connexion internet requise.");
      this.name = "LLMIndisponibleError";
    }
  }

  const CODES_ERREUR_RESEAU = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

  export function estErreurReseau(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const e = err as Error & { code?: string; cause?: { code?: string } };
    if (e.code && CODES_ERREUR_RESEAU.has(e.code)) return true;
    if (e.cause?.code && CODES_ERREUR_RESEAU.has(e.cause.code)) return true;
    return /fetch failed/i.test(e.message);
  }
  ```

- [ ] **Step 2 : Lever `LLMIndisponibleError` aux deux points d'appel réseau**

  ```typescript
  // src/lib/llm.ts — invokeLLM, remplace le corps existant
  export async function invokeLLM(options: LLMOptions): Promise<string> {
    const { messages, model = "gpt-4o", temperature = 0.3, maxTokens = 2000 } = options;

    if (process.env.OPENAI_API_KEY) {
      try {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await client.chat.completions.create({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        });
        return response.choices[0]?.message?.content ?? "Réponse non disponible";
      } catch (err) {
        if (estErreurReseau(err)) throw new LLMIndisponibleError();
        if (!shouldFallback(err)) throw err;
        console.warn("[LLM] OpenAI indisponible, bascule sur Groq:", (err as Error).message);
      }
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      throw new Error("Aucun fournisseur LLM configuré (OPENAI_API_KEY ou GROQ_API_KEY requis).");
    }

    try {
      const client = new Groq({ apiKey: groqKey });
      const response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature,
        max_tokens: maxTokens,
      });
      return response.choices[0]?.message?.content ?? "Réponse non disponible";
    } catch (err) {
      if (estErreurReseau(err)) throw new LLMIndisponibleError();
      throw err;
    }
  }
  ```

- [ ] **Step 3 : La route API renvoie un message clair au lieu d'un 500 brut**

  ```typescript
  // src/app/api/ai/chat/route.ts
  import { invokeLLM, LLMIndisponibleError } from "@/lib/llm";
  ```

  Remplacer `const assistantMessage = await invokeLLM({ messages });` par :

  ```typescript
  let assistantMessage: string;
  try {
    assistantMessage = await invokeLLM({ messages });
  } catch (err) {
    if (err instanceof LLMIndisponibleError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
  ```

- [ ] **Step 4 : Écrire le test**

  ```typescript
  // scripts/test-llm-offline.ts
  //
  // Teste la detection d'erreur reseau en pur (aucun appel reseau reel) :
  // usage : npx tsx scripts/test-llm-offline.ts
  import { estErreurReseau, LLMIndisponibleError } from "../src/lib/llm";

  let ok = 0;
  let ko = 0;
  function check(nom: string, condition: boolean) {
    if (condition) {
      ok++;
      console.log(`  ✓ ${nom}`);
    } else {
      ko++;
      console.error(`  ✗ ${nom}`);
    }
  }

  check(
    "ENOTFOUND detecte comme erreur reseau",
    estErreurReseau(Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" })),
  );
  check(
    "ECONNREFUSED (cause imbriquee, fetch natif) detecte",
    estErreurReseau(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
  );
  check(
    "erreur applicative (401) NON traitee comme reseau",
    !estErreurReseau(Object.assign(new Error("Unauthorized"), { status: 401 })),
  );
  check("LLMIndisponibleError porte un message clair", new LLMIndisponibleError().message.includes("connexion internet"));

  console.log(`\n${ok} assertion(s) OK, ${ko} en echec.`);
  process.exit(ko === 0 ? 0 : 1);
  ```

- [ ] **Step 5 : Script npm + validation**

  ```json
  "scripts": {
    "test:llm": "npx tsx scripts/test-llm-offline.ts"
  }
  ```

  ```
  npx tsc --noEmit
  npx eslint src/lib/llm.ts src/app/api/ai/chat/route.ts scripts/test-llm-offline.ts
  npm run test:llm
  ```

  Attendu : 4/4 assertions OK.

- [ ] **Step 6 : Commit**

  ```bash
  git add src/lib/llm.ts src/app/api/ai/chat/route.ts scripts/test-llm-offline.ts package.json
  git commit -m "fix(ai): degradation propre du chat IA sans connexion (LLMIndisponibleError, 503 au lieu d'un 500 brut)"
  ```

---

## Task 7: `runtime-env.ts` — chemins persistants, secret, cache OCR

**Files:**
- Create: `desktop/src/runtime-env.ts`

**Interfaces:**
- Consumes: rien (module autonome, dépend seulement d'Electron `app`).
- Produces: `dossierDonnees()`, `dossierPgData()`, `dossierLogs()`, `dossierCacheTesseract()`, `secretAuthPersiste(): string`, `amorcerCacheTesseract(cheminRessources: string): string`, `construireEnvRuntime(options: { portPostgres: number; portNext: number; cheminRessources: string }): NodeJS.ProcessEnv` — tous consommés par Task 9 (`main.ts`).

- [ ] **Step 1 : Écrire le module**

  ```typescript
  // desktop/src/runtime-env.ts
  import { app } from "electron";
  import { randomBytes } from "node:crypto";
  import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
  import path from "node:path";

  /** Racine des donnees persistantes de l'app (survit aux mises a jour). */
  export function dossierDonnees(): string {
    const dir = path.join(app.getPath("appData"), "GeoAino");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  export function dossierPgData(): string {
    return path.join(dossierDonnees(), "pgdata");
  }

  export function dossierLogs(): string {
    const dir = path.join(dossierDonnees(), "logs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  export function dossierCacheTesseract(): string {
    const dir = path.join(dossierDonnees(), "tesseract-cache");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * NEXTAUTH_SECRET doit rester stable entre deux lancements (sinon les
   * sessions sont invalidees a chaque redemarrage) mais n'a pas besoin
   * d'etre connu a l'avance : genere une seule fois, a la premiere execution.
   */
  export function secretAuthPersiste(): string {
    const fichier = path.join(dossierDonnees(), "auth.secret");
    if (existsSync(fichier)) return readFileSync(fichier, "utf8").trim();
    const secret = randomBytes(32).toString("hex");
    writeFileSync(fichier, secret, "utf8");
    return secret;
  }

  /**
   * Amorce le cache local de donnees de langue tesseract avec le fichier
   * embarque dans les ressources de l'app, si absent (premier lancement).
   * `ocr.ts` lit ce dossier via GEOAINO_TESSERACT_LANG_PATH (cf. Task 5).
   */
  export function amorcerCacheTesseract(cheminRessources: string): string {
    const dest = dossierCacheTesseract();
    const cible = path.join(dest, "eng.traineddata.gz");
    if (!existsSync(cible)) {
      const source = path.join(cheminRessources, "tesseract-lang", "eng.traineddata.gz");
      copyFileSync(source, cible);
    }
    return dest;
  }

  export function construireEnvRuntime(options: {
    portPostgres: number;
    portNext: number;
    cheminRessources: string;
  }): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(options.portNext),
      DATABASE_URL: `postgresql://postgres@127.0.0.1:${options.portPostgres}/geoaino?schema=public`,
      NEXTAUTH_URL: `http://127.0.0.1:${options.portNext}`,
      NEXTAUTH_SECRET: secretAuthPersiste(),
      GEOAINO_TESSERACT_LANG_PATH: amorcerCacheTesseract(options.cheminRessources),
    };
  }
  ```

- [ ] **Step 2 : Valider**

  ```
  npx tsc -p desktop/tsconfig.json --noEmit
  npx eslint desktop/src/runtime-env.ts
  ```

  (Pas de script de test dédié : ce module n'a de sens qu'avec une instance Electron `app` réelle — il est couvert de bout en bout par le smoke test d'empaquetage, Task 10.)

- [ ] **Step 3 : Commit**

  ```bash
  git add desktop/src/runtime-env.ts
  git commit -m "feat(desktop): chemins de donnees persistants, secret NEXTAUTH et amorcage du cache OCR"
  ```

---

## Task 8: `next-server.ts` — sous-processus Next standalone

**Files:**
- Create: `desktop/src/next-server.ts`

**Interfaces:**
- Consumes: rien de nouveau (types Node standard).
- Produces: `type ServeurNext = { processus: ChildProcess; arreter: () => Promise<void> }`, `demarrerNextStandalone(options: { cheminServeur: string; env: NodeJS.ProcessEnv; fichierLog: string }): ServeurNext`, `attendreServeurPret(port: number, delaiMaxMs?: number): Promise<void>` — consommés par Task 9 (`main.ts`).

- [ ] **Step 1 : Écrire le module**

  ```typescript
  // desktop/src/next-server.ts
  import { ChildProcess, spawn } from "node:child_process";
  import { createWriteStream } from "node:fs";
  import path from "node:path";

  export type ServeurNext = {
    processus: ChildProcess;
    arreter: () => Promise<void>;
  };

  /**
   * Demarre le build `output: standalone` (server.js) comme process enfant,
   * avec l'environnement runtime deja calcule (DATABASE_URL, ports, etc. —
   * cf. runtime-env.ts). `cheminServeur` pointe vers
   * `<resources>/app/server.js` (cf. Task 10, extraResources).
   */
  export function demarrerNextStandalone(options: {
    cheminServeur: string;
    env: NodeJS.ProcessEnv;
    fichierLog: string;
  }): ServeurNext {
    const log = createWriteStream(options.fichierLog, { flags: "a" });
    const processus = spawn(process.execPath, [options.cheminServeur], {
      cwd: path.dirname(options.cheminServeur),
      env: options.env,
      windowsHide: true,
    });
    processus.stdout?.pipe(log);
    processus.stderr?.pipe(log);

    return {
      processus,
      arreter: () =>
        new Promise((resolve) => {
          processus.once("exit", () => resolve());
          processus.kill();
          setTimeout(resolve, 3000); // filet de securite si l'arret propre traine
        }),
    };
  }

  /** Sonde `http://127.0.0.1:<port>` jusqu'a obtenir une reponse HTTP. */
  export async function attendreServeurPret(port: number, delaiMaxMs = 20_000): Promise<void> {
    const debut = Date.now();
    while (Date.now() - debut < delaiMaxMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`);
        if (res.status < 500) return;
      } catch {
        // pas encore pret
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Le serveur Next.js local n'a pas repondu dans les ${delaiMaxMs}ms.`);
  }
  ```

- [ ] **Step 2 : Valider**

  ```
  npx tsc -p desktop/tsconfig.json --noEmit
  npx eslint desktop/src/next-server.ts
  ```

- [ ] **Step 3 : Commit**

  ```bash
  git add desktop/src/next-server.ts
  git commit -m "feat(desktop): demarrage/arret du serveur Next.js standalone en sous-processus"
  ```

---

## Task 9: `main.ts` — orchestration complète du process principal Electron

**Files:**
- Create: `desktop/src/main.ts`

**Interfaces:**
- Consumes: `demarrerPostgresPortable`, `ClusterPostgres` (Task 2) ; `trouverPortLibre` (Task 2) ; `demarrerNextStandalone`, `attendreServeurPret`, `ServeurNext` (Task 8) ; `construireEnvRuntime`, `dossierPgData`, `dossierLogs` (Task 7) ; `hash` de `bcryptjs` (déjà une dépendance du projet, utilisée telle quelle par `src/lib/auth.ts` — même algorithme, pour qu'un compte créé ici s'authentifie normalement via `CredentialsProvider`).
- Produces: point d'entrée exécutable `desktop/dist/main.js` (après compilation, cf. Task 2 Step 4) — consommé par Task 10 (`electron-builder.yml`, `files`).

**Convention de disposition des ressources packagées** (posée ici, réutilisée telle quelle par Task 10) :

```
<process.resourcesPath>/
  pg-portable/     ← Task 1
  tesseract-lang/  ← Task 5
  app/             ← Task 3 (.next/standalone + public + .next/static)
  prisma-cli/      ← copie de node_modules/prisma (le paquet CLI)
  prisma/          ← copie de prisma/ (schema.prisma + migrations/)
```

- [ ] **Step 1 : Écrire le module**

  ```typescript
  // desktop/src/main.ts
  import { app, BrowserWindow, dialog } from "electron";
  import path from "node:path";
  import { randomBytes } from "node:crypto";
  import { spawnSync } from "node:child_process";
  import { hash } from "bcryptjs";
  import { demarrerPostgresPortable, type ClusterPostgres } from "./postgres-manager";
  import { trouverPortLibre } from "./port-utils";
  import { demarrerNextStandalone, attendreServeurPret, type ServeurNext } from "./next-server";
  import { construireEnvRuntime, dossierPgData, dossierLogs } from "./runtime-env";

  const CANDIDATS_PORT_PG = [54329, 54330, 54331, 54332, 54333];
  const CANDIDATS_PORT_NEXT = [4173, 4174, 4175, 4176, 4177];

  const cheminRessources = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, "..", "vendor");

  let clusterPg: ClusterPostgres | null = null;
  let serveurNext: ServeurNext | null = null;
  let fenetre: BrowserWindow | null = null;

  function executerPsql(port: number, args: string[]) {
    const psql = path.join(cheminRessources, "pg-portable", "bin", "psql.exe");
    return spawnSync(psql, ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", ...args]);
  }

  /** Cree la base applicative + l'extension PostGIS si elles n'existent pas encore. */
  function assurerBaseEtExtension(port: number): void {
    const existe = executerPsql(port, ["-tAc", "SELECT 1 FROM pg_database WHERE datname = 'geoaino'"]);
    if (existe.stdout?.toString().trim() !== "1") {
      const creation = executerPsql(port, ["-c", "CREATE DATABASE geoaino"]);
      if (creation.status !== 0) {
        throw new Error(`Creation de la base 'geoaino' echouee : ${creation.stderr?.toString()}`);
      }
    }
    const extension = executerPsql(port, ["-d", "geoaino", "-c", "CREATE EXTENSION IF NOT EXISTS postgis;"]);
    if (extension.status !== 0) {
      throw new Error(`CREATE EXTENSION postgis echoue : ${extension.stderr?.toString()}`);
    }
  }

  function appliquerMigrations(env: NodeJS.ProcessEnv): void {
    const migrate = spawnSync(
      process.execPath,
      [
        path.join(cheminRessources, "prisma-cli", "build", "index.js"),
        "migrate",
        "deploy",
        "--schema",
        path.join(cheminRessources, "prisma", "schema.prisma"),
      ],
      { env, cwd: cheminRessources },
    );
    if (migrate.status !== 0) {
      throw new Error(`prisma migrate deploy a echoue : ${migrate.stderr?.toString() || migrate.stdout?.toString()}`);
    }
  }

  /**
   * Cree un compte ADMIN initial si la base ne contient encore aucun
   * utilisateur (premier lancement seulement) — sans ca, l'operateur n'a
   * aucun moyen de se connecter a une installation neuve (spec, § Cycle de
   * demarrage). Insertion SQL directe plutot que via Prisma Client : le
   * process principal Electron n'a besoin d'aucune autre dependance a
   * Prisma que le CLI deja invoque pour les migrations (cf.
   * appliquerMigrations). Le hachage utilise `bcryptjs` — meme algorithme
   * que `CredentialsProvider` (src/lib/auth.ts) — pour qu'un mot de passe
   * cree ici s'authentifie normalement une fois l'app ouverte.
   * Renvoie `email / mot de passe` si un compte a ete cree, sinon `null`.
   */
  async function amorcerCompteAdmin(port: number): Promise<string | null> {
    const compte = executerPsql(port, ["-d", "geoaino", "-tAc", 'SELECT count(*) FROM "User"']);
    if (compte.status !== 0) {
      throw new Error(`Verification du compte initial echouee : ${compte.stderr?.toString()}`);
    }
    if (Number(compte.stdout?.toString().trim()) > 0) return null;

    const email = "admin@geoaino.local";
    const motDePasse = randomBytes(9).toString("base64url");
    const hachage = (await hash(motDePasse, 10)).replace(/'/g, "''");
    const insertion = executerPsql(port, [
      "-d", "geoaino",
      "-c",
      `INSERT INTO "User" (id, email, password, role, "lastSignedIn") VALUES (gen_random_uuid()::text, '${email}', '${hachage}', 'ADMIN', now());`,
    ]);
    if (insertion.status !== 0) {
      throw new Error(`Creation du compte ADMIN initial echouee : ${insertion.stderr?.toString()}`);
    }
    return `${email} / ${motDePasse}`;
  }

  async function demarrerApplication(): Promise<void> {
    clusterPg = await demarrerPostgresPortable({
      binDir: path.join(cheminRessources, "pg-portable", "bin"),
      dataDir: dossierPgData(),
      candidatsPort: CANDIDATS_PORT_PG,
    });

    assurerBaseEtExtension(clusterPg.port);

    const portNext = await trouverPortLibre(CANDIDATS_PORT_NEXT);
    const env = construireEnvRuntime({
      portPostgres: clusterPg.port,
      portNext,
      cheminRessources,
    });

    appliquerMigrations(env);

    const identifiantsInitiaux = await amorcerCompteAdmin(clusterPg.port);
    if (identifiantsInitiaux) {
      dialog.showMessageBoxSync({
        type: "info",
        title: "Compte administrateur cree",
        message: "Un compte administrateur a ete cree pour cette installation.",
        detail: `Identifiants (a noter, non recuperables ensuite) :\n${identifiantsInitiaux}`,
      });
    }

    serveurNext = demarrerNextStandalone({
      cheminServeur: path.join(cheminRessources, "app", "server.js"),
      env,
      fichierLog: path.join(dossierLogs(), "next.log"),
    });
    await attendreServeurPret(portNext);

    fenetre = new BrowserWindow({ width: 1400, height: 900, show: false });
    await fenetre.loadURL(`http://127.0.0.1:${portNext}`);
    fenetre.show();
  }

  app.on("ready", () => {
    demarrerApplication().catch((err) => {
      console.error("Echec du demarrage :", err);
      app.quit();
    });
  });

  let arretEnCours = false;
  app.on("before-quit", (event) => {
    if (arretEnCours || (!serveurNext && !clusterPg)) return;
    arretEnCours = true;
    event.preventDefault();
    (async () => {
      if (serveurNext) await serveurNext.arreter();
      if (clusterPg) await clusterPg.arreter();
      serveurNext = null;
      clusterPg = null;
      app.quit();
    })();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  ```

- [ ] **Step 2 : Compiler et valider**

  ```
  npm run build:desktop
  npx tsc -p desktop/tsconfig.json --noEmit
  npx eslint desktop/src/main.ts
  ```

  Attendu : `desktop/dist/main.js` produit sans erreur.

  (Pas de test automatisé pour ce fichier : l'orchestration complète — cluster réel, migrations réelles, fenêtre réelle — n'a de sens qu'empaquetée. Elle est couverte par le smoke test manuel de Task 10/11.)

- [ ] **Step 3 : Commit**

  ```bash
  git add desktop/src/main.ts
  git commit -m "feat(desktop): orchestration complete du process principal Electron (postgres, migrations, serveur Next, fenetre)"
  ```

---

## Task 10: Empaquetage electron-builder + smoke test de l'installateur

**Files:**
- Create: `desktop/electron-builder.yml`
- Modify: `package.json` — script `dist:desktop`

**Interfaces:**
- Consumes: `desktop/dist/main.js` (Task 9), `.next/standalone` (Task 3), `desktop/vendor/pg-portable` (Task 1), `desktop/vendor/tesseract-lang` (Task 5), `node_modules/prisma`, `prisma/` (racine).
- Produces: `desktop/dist-installer/GeoAino Setup <version>.exe` — consommé par Task 11 (test de désinstallation).

- [ ] **Step 1 : Configuration electron-builder**

  ```yaml
  # desktop/electron-builder.yml
  appId: com.geoaino.desktop
  productName: GeoAino
  directories:
    output: dist-installer
  files:
    - dist/**/*
    - ../package.json
  extraResources:
    - from: vendor/pg-portable
      to: pg-portable
    - from: vendor/tesseract-lang
      to: tesseract-lang
    - from: ../.next/standalone
      to: app
    - from: ../node_modules/prisma
      to: prisma-cli
    - from: ../prisma
      to: prisma
  win:
    target: nsis
  nsis:
    oneClick: false
    allowToChangeInstallationDirectory: true
    deleteAppDataOnUninstall: false
  ```

  (`deleteAppDataOnUninstall: false` est le défaut d'electron-builder et ne s'applique qu'à l'installateur « one-click » — ici `oneClick: false`, donc ce réglage est surtout documentaire ; la garantie réelle contre une suppression des données au désinstall est vérifiée à la main en Task 11, pas déduite de cette seule option.)

- [ ] **Step 2 : Script npm**

  ```json
  "scripts": {
    "dist:desktop": "npm run build:standalone && npm run build:desktop && electron-builder --config desktop/electron-builder.yml"
  }
  ```

- [ ] **Step 3 : Construire l'installateur**

  Prérequis : Task 1 (bundle Postgres+PostGIS), Task 5 Step 1 (données de langue) et Task 9 Step 2 (`desktop/dist/main.js`) déjà faits dans cet environnement.

  ```
  npm run dist:desktop
  ```

  Attendu : `desktop/dist-installer/GeoAino Setup <version>.exe` produit, sans erreur electron-builder.

- [ ] **Step 4 : Smoke test — contenu des ressources**

  electron-builder produit aussi un dossier non compressé (`desktop/dist-installer/win-unpacked/`) avant de générer le `.exe` — l'inspecter directement, plus rapide qu'une installation complète pour vérifier le contenu :

  ```
  ls desktop/dist-installer/win-unpacked/resources/pg-portable/bin/postgres.exe
  ls desktop/dist-installer/win-unpacked/resources/tesseract-lang/eng.traineddata.gz
  ls desktop/dist-installer/win-unpacked/resources/app/server.js
  ls desktop/dist-installer/win-unpacked/resources/prisma-cli/build/index.js
  ls desktop/dist-installer/win-unpacked/resources/prisma/schema.prisma
  ```

  Les cinq doivent exister. Si l'un manque, corriger le `extraResources` correspondant avant de continuer — ne pas passer à l'étape suivante sur un doute.

- [ ] **Step 5 : Smoke test — premier lancement réel**

  Lancer `desktop/dist-installer/win-unpacked/GeoAino.exe` directement (pas besoin d'installer pour ce test).

  Checklist manuelle (aucune de ces étapes n'est automatisable sans un framework d'UI-testing que le projet n'a pas — cohérent avec le reste du projet, qui n'a que des scripts `tsx`) :
  - une boîte de dialogue affiche `admin@geoaino.local / <mot de passe généré>` avant l'ouverture de la fenêtre principale (`amorcerCompteAdmin`, Task 9) — noter ce mot de passe, il n'est plus récupérable ensuite ;
  - la fenêtre s'ouvre sur la page de login (pas d'écran d'erreur) ;
  - `%APPDATA%\GeoAino\pgdata\PG_VERSION` existe après ce premier lancement ;
  - `%APPDATA%\GeoAino\logs\next.log` ne contient pas d'erreur fatale ;
  - se connecter avec les identifiants affichés par la boîte de dialogue confirme que l'authentification fonctionne bout en bout ;
  - fermer la fenêtre puis relancer `GeoAino.exe` : le second démarrage est nettement plus rapide (pas de ré-`initdb`), les données créées persistent, et **aucune** nouvelle boîte de dialogue de compte n'apparaît (la base contient déjà un utilisateur).

- [ ] **Step 6 : Commit**

  ```bash
  git add desktop/electron-builder.yml package.json
  git commit -m "build(desktop): empaquetage NSIS (electron-builder), ressources embarquees (postgres, tesseract, app standalone, prisma)"
  ```

---

## Task 11: Comportement de désinstallation

**Files:** aucun changement de code — vérification sur l'installateur produit par Task 10.

**Interfaces:** aucune.

- [ ] **Step 1 : Installer réellement (pas juste `win-unpacked`)**

  Exécuter `desktop/dist-installer/GeoAino Setup <version>.exe`, terminer l'installation, lancer l'app au moins une fois pour qu'elle crée `%APPDATA%\GeoAino\`.

- [ ] **Step 2 : Désinstaller**

  Via le Panneau de configuration Windows (« Applications installées ») ou l'exécutable `Uninstall GeoAino.exe` du dossier d'installation.

- [ ] **Step 3 : Vérifier**

  ```
  dir "%APPDATA%\GeoAino"
  ```

  Attendu : le dossier et son contenu (`pgdata/`, `logs/`, `tesseract-cache/`, `auth.secret`) **existent toujours** après la désinstallation — c'est le comportement attendu (spec : « ne doit pas supprimer silencieusement les données cadastrales du client »). Si le dossier a disparu, la config NSIS (Task 10) a un comportement inattendu à corriger avant toute distribution réelle : ce test bloque la livraison, pas seulement ce plan.

- [ ] **Step 4 : Documenter le résultat**

  Aucun fichier à committer pour cette tâche — consigner le résultat de la vérification (dans le ticket/l'issue de suivi du projet, pas dans ce dépôt) : confirmé conforme, ou écart à corriger avant toute distribution à un client.
