# 🖥️ Bureau autonome GeoAino (Electron + PostgreSQL/PostGIS portable)

Documentation du packaging desktop de geoaino-next : un installateur Windows
**mono-poste**, **hors ligne**, avec **parité fonctionnelle complète** avec le
web, destiné à la distribution/vente à des tiers (mairies, cabinets de
géomètres, etc.) qui ne veulent/peuvent pas héberger l'app web + PostGIS
eux-mêmes.

> Spec d'architecture complète : [`docs/superpowers/specs/2026-09-11-bureau-autonome-design.md`](./superpowers/specs/2026-09-11-bureau-autonome-design.md)
> Plan d'implémentation (11 tâches) : [`docs/superpowers/plans/2026-09-11-bureau-autonome.md`](./superpowers/plans/2026-09-11-bureau-autonome.md)

---

## 1. Architecture en un coup d'œil

```mermaid
flowchart TD
    A["GeoAino.exe<br/>(process principal Electron)"] -->|"pg_ctl start<br/>(pg-portable/bin)"| B[("PostgreSQL 16 + PostGIS<br/>127.0.0.1:54329-54333")]
    A -->|"spawn server.js<br/>(Next standalone)"| C["Serveur Next.js<br/>127.0.0.1:4173-4177"]
    A -->|"loadURL"| D["BrowserWindow"]
    D -->|"HTTP"| C
    C -->|"DATABASE_URL"| B
    B -.->|"donnees persistantes"| E["%APPDATA%\\GeoAino\\pgdata"]
```

Un seul exécutable (`GeoAino.exe`) orchestre trois choses au démarrage :

1. **PostgreSQL/PostGIS portable** (aucune installation système requise) —
   `desktop/src/postgres-manager.ts` : `initdb` au tout premier lancement,
   puis `pg_ctl start` à chaque lancement, sur un port libre choisi parmi
   `54329-54333`.
2. **Le serveur Next.js en mode `standalone`** — `desktop/src/next-server.ts` :
   même code que le web (`src/`), packagé une fois pour toutes au build, lancé
   comme process enfant sur un port libre parmi `4173-4177`.
3. **Une fenêtre Electron** pointée sur `http://127.0.0.1:<port Next>` —
   aucune interface web n'est exposée hors de la machine (tout est lié à
   `127.0.0.1`).

| Fichier | Rôle |
| --- | --- |
| `desktop/src/main.ts` | Cycle de vie de l'app : verrou mono-instance, orchestration démarrage/arrêt, amorçage du compte admin, synchronisation du schéma, création des index spatiaux |
| `desktop/src/postgres-manager.ts` | `initdb`/`pg_ctl` du cluster Postgres portable, nettoyage d'un verrou orphelin, arrêt propre |
| `desktop/src/next-server.ts` | Démarrage du `server.js` standalone en process enfant, sonde de disponibilité (`/api/auth/session`) |
| `desktop/src/runtime-env.ts` | Construit l'environnement du process Next (URLs, secrets, chemins) + tous les chemins sous `%APPDATA%\GeoAino` |
| `desktop/src/port-utils.ts` | Recherche d'un port TCP libre parmi une liste de candidats |
| `desktop/electron-builder.yml` | Configuration de l'installateur NSIS (ressources embarquées, exclusions) |
| `desktop/scripts/assemble-pg-portable.ps1` | Script one-shot (voir §4) qui télécharge/assemble le bundle PostgreSQL+PostGIS portable dans `desktop/vendor/pg-portable` |

### Clé d'activation (protection de licence)

Chaque installation doit être activée par une licence liée à la machine
avant de pouvoir démarrer Postgres/Next — voir
[`docs/superpowers/specs/2026-09-13-cle-activation-desktop-design.md`](./superpowers/specs/2026-09-13-cle-activation-desktop-design.md)
pour le design complet. En bref :

1. Au premier lancement (ou si `licence.dat` est absente/invalide), l'app
   affiche l'empreinte de la machine (dérivée du `MachineGuid` Windows,
   `desktop/src/machine-id.ts`) et bloque tout démarrage de Postgres/Next
   tant qu'aucune licence valide n'est importée.
2. Le client transmet cette empreinte au vendeur.
3. **Vendeur** (une seule fois par installation de l'outillage) :
   ```bash
   npx tsx desktop/scripts/licence/generer-cle-vendeur.ts   # une seule fois, jamais rejoue
   npx tsx desktop/scripts/licence/generer-licence.ts "<empreinte du client>" "<nom du client>"
   npx tsx desktop/scripts/licence/verifier-licence.ts licence-<nom>.geoaino
   ```
   La clé privée générée par `generer-cle-vendeur.ts` est écrite par défaut
   sous `~/.geoaino-vendeur/cle-privee-vendeur.pem` (hors du dépôt), pas dans
   `desktop/scripts/licence/` — chemin personnalisable via la variable
   d'environnement `GEOAINO_CLE_PRIVEE_VENDEUR`.
4. Le fichier `licence-<nom>.geoaino` produit est transmis au client (email,
   clé USB), qui l'importe via le bouton « Importer une licence ».
5. La licence est enregistrée dans `%APPDATA%\GeoAino\licence.dat` et
   revalidée (signature + empreinte) à chaque lancement suivant.

**Limitations assumées** (cf. spec pour le détail) :
- Perte/compromission de la clé privée vendeur (`cle-privee-vendeur.pem`,
  jamais committée) → toutes les licences déjà émises deviennent invalides
  après rotation de la clé, il faut republier l'app avec la nouvelle clé
  publique et réémettre une licence à chaque client existant.
- Réinstallation de Windows ou changement de disque sur le poste client →
  nouvelle empreinte machine → l'ancienne licence ne fonctionne plus, il
  faut en émettre une nouvelle.
- Aucune révocation à distance d'une licence déjà activée (cohérent avec le
  choix « 100% hors ligne, perpétuelle »).

### Référentiels administratifs (communes, arrondissements, CSF)

La construction du NICAD (Syscol + section) dépend de 4 référentiels
administratifs statiques (`cad_communes_2013`, `cad_communes_2026`,
`cad_arrondissements`, `cad_correspondance_2013_2026`) — sans eux, aucune
section ne peut être résolue par jointure spatiale (`build-sections.ts`),
et aucun NICAD n'est jamais assigné aux parcelles importées. Un 5e
référentiel, `cad_centres_services_fiscaux` (CSF), est chargé de la même
façon mais sert uniquement à l'affichage carte (sélecteur « Limites admin »
sur `/cadastre/sections` et `/map/`) — il n'intervient dans aucune
résolution de NICAD.

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

### Emplacement des données persistantes

Tout ce qui doit survivre à une mise à jour (ou une désinstallation) vit sous
`%APPDATA%\GeoAino\` — **jamais** dans le dossier d'installation
(`%LOCALAPPDATA%\Programs\GeoAino\`), qui lui est remplacé/supprimé sans
ménagement à chaque mise à jour/désinstallation :

```
%APPDATA%\GeoAino\
├── pgdata\                      Cluster PostgreSQL/PostGIS complet
├── logs\next.log                Sortie du serveur Next.js standalone
├── auth.secret                  NEXTAUTH_SECRET généré une seule fois (stable entre lancements)
└── identifiants-initiaux.txt    Filet de secours : email/mot de passe admin (créé une seule fois)
```

`nsis: deleteAppDataOnUninstall: false` (`desktop/electron-builder.yml`)
garantit que ce dossier n'est **jamais** supprimé par le désinstalleur —
confirmé par test réel (voir §5).

---

## 2. Prérequis avant un premier build

Le bundle PostgreSQL 16 + PostGIS portable (~450 Mo décompressés) n'est **pas**
committé dans le dépôt — il doit être assemblé une fois sur la machine de
build :

```bash
# Depuis la racine du dépôt (PowerShell) :
powershell -ExecutionPolicy Bypass -File desktop/scripts/assemble-pg-portable.ps1
```

Résultat attendu : `desktop/vendor/pg-portable/bin/{pg_ctl,initdb,psql,pg_isready}.exe`
et `desktop/vendor/pg-portable/lib/postgis-3.dll` (entre autres). Cette étape
télécharge les zips EDB (PostgreSQL) et OSGeo (PostGIS) puis les fusionne —
voir le script pour le détail. **Une seule fois par machine de build** (le
résultat est réutilisé par tous les builds suivants tant que `desktop/vendor/`
n'est pas supprimé).

Les référentiels administratifs (voir section dédiée plus haut) doivent
également être générés avant un build de distribution :

```bash
npx tsx desktop/scripts/generer-referentiels.ts --url "postgresql://postgres:PASSWORD@HOST:PORT/DB_WEB"
```

### Fond de carte hors ligne (`desktop/vendor/tiles/senegal.mbtiles`)

Les cartes lisent un MBTiles OpenMapTiles via la route `/api/tiles`.
Electron passe son chemin à Next par `BASEMAP_MBTILES_PATH` (`runtime-env.ts`),
et `electron-builder.yml` l'embarque dans `resources/tiles/`. Le principe est
détaillé dans `docs/CONCEPTS-TRAITEMENT-DXF.md` §71. Le fichier (~126 Mo)
n'est **pas** committé. Pour le générer, **hors du dépôt**, sinon le build
Next tente de parcourir les fichiers de travail :

```bash
mkdir ../geoaino-tiles-build && cd ../geoaino-tiles-build
curl -L -o planetiler.jar https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
curl -L -o senegal-and-gambia-latest.osm.pbf https://download.geofabrik.de/africa/senegal-and-gambia-latest.osm.pbf
# --download récupère les données complémentaires (~1,4 Go : océans, Natural Earth, lacs).
# Si la connexion coupe, retélécharger data/sources/water-polygons-split-3857.zip
# avec `curl -C -` puis relancer sans --download.
java -Xmx3g -jar planetiler.jar --osm-path=senegal-and-gambia-latest.osm.pbf --download --output=senegal.mbtiles --force
cp senegal.mbtiles ../geoaino-next/desktop/vendor/tiles/senegal.mbtiles
```

Côté web, définir `BASEMAP_MBTILES_PATH` (chemin absolu du même fichier).
Sans cette variable, les cartes reviennent aux tuiles OSM publiques,
soumises au bridage du serveur `tile.openstreetmap.org`.

---

## 3. Commandes de build

| Commande | Ce qu'elle fait |
| --- | --- |
| `npm run build:standalone` | `next build` avec `GEOAINO_DESKTOP_BUILD=1` (active `output: "standalone"`) puis copie les assets nécessaires (`scripts/copy-standalone-assets.mjs`) dans `.next/standalone` |
| `npm run build:desktop` | Compile `desktop/src/*.ts` → `desktop/dist/*.js` via `tsc -p desktop/tsconfig.json` |
| `npm run dist:desktop` | Enchaîne les deux commandes ci-dessus **puis** `electron-builder --config desktop/electron-builder.yml` → produit l'installateur NSIS |

**Build complet, depuis la racine du dépôt :**

```bash
npm run dist:desktop
```

Sortie : `desktop/dist-installer/GeoAino Setup <version>.exe` (~700-750 Mo,
la majeure partie étant PostgreSQL/PostGIS + Electron runtime + le runtime
Next standalone). Compter plusieurs minutes (l'essentiel du temps est la
compression NSIS du `.asar`/ressources).

`npm run build` (sans `build:standalone`) reste le build web normal
(`output` non défini) — **ne jamais utiliser `build:standalone` pour l'image
Docker web**, les deux chemins sont volontairement séparés
(`next.config.ts`, variable `GEOAINO_DESKTOP_BUILD`).

---

## 4. Commandes de test

Aucun de ces tests ne nécessite Electron ni un build packagé — ils tournent
directement sur le code source :

| Commande | Couverture |
| --- | --- |
| `npm run test:llm` | Détection d'erreur réseau vs erreur applicative pour le fallback LLM hors ligne (`LLMIndisponibleError`) — 4 assertions |
| `npx tsc --noEmit` | Vérification TypeScript du code web (`src/`) |
| `npx tsc -p desktop/tsconfig.json --noEmit` | Vérification TypeScript du code Electron (`desktop/src/`) — **à lancer séparément**, tsconfig dédié (types `node`+`electron`) |
| `npx tsc -p desktop/tsconfig.scripts.json --noEmit` | Vérification TypeScript de l'outillage vendeur (`desktop/scripts/`), non couvert par `desktop/tsconfig.json` (qui n'inclut que `src/`) |
| `npx tsx desktop/scripts/test-postgres-manager.ts` | Test d'intégration réel : démarre/arrête un vrai cluster Postgres portable via `demarrerPostgresPortable` (nécessite `desktop/vendor/pg-portable` déjà assemblé, §2) |
| `npx tsx desktop/scripts/test-machine-id.ts` | Format/déterminisme/unicité de l'empreinte machine — pur, sans toucher au registre Windows |
| `npx tsx desktop/scripts/test-licence.ts` | Vérification de signature Ed25519 (acceptation/rejet) — clé de test jetable, sans dépendre de la vraie clé vendeur |

**Avant tout build de distribution**, lancer dans l'ordre :

```bash
npm run test:llm
npx tsc --noEmit
npx tsc -p desktop/tsconfig.json --noEmit
```

Les 4 doivent être verts. Il n'y a pas de suite de tests automatisée pour le
cycle de démarrage Electron lui-même (verrou mono-instance, orchestration
Postgres/Next) — celui-ci se vérifie **manuellement**, en installant
réellement l'app (voir §5 et §6).

---

## 5. Vérification manuelle (installation / premier lancement / désinstallation)

Il n'existe pas de mode automatisé pour ces trois étapes — à faire à la main
après chaque changement touchant `desktop/src/*.ts` ou
`desktop/electron-builder.yml` :

Avant toute chose : le premier lancement affichera la boîte d'activation
décrite ci-dessus (section « Clé d'activation ») — générer une licence de
test pour l'empreinte affichée (`generer-licence.ts`) avant de pouvoir
poursuivre les étapes ci-dessous.

1. **Installer réellement** (pas seulement lancer `win-unpacked`) :
   ```
   "desktop/dist-installer/GeoAino Setup <version>.exe"
   ```
   Suivre l'assistant (ou `/S` pour un mode silencieux non interactif). Ne
   pas la première fois utiliser un chemin contenant des espaces si vous
   testez depuis un environnement en bac à sable (cf. Task 11).

2. **Premier lancement** — vérifier :
   - Une boîte de dialogue affiche **une fois** les identifiants admin
     (`admin@geoaino.local` / mot de passe généré) — les noter, ils ne sont
     plus jamais réaffichés (filet de secours dans
     `%APPDATA%\GeoAino\identifiants-initiaux.txt`).
   - `%APPDATA%\GeoAino\pgdata`, `logs\next.log`, `auth.secret` existent
     tous.
   - Connexion possible avec les identifiants affichés.
   - `SELECT count(*) FROM cad_communes_2026` sur la base desktop retourne
     un nombre > 0 (référentiels administratifs chargés).

3. **Second lancement** (fermer puis relancer l'app) — vérifier :
   - Pas de nouvelle boîte d'identifiants (le compte existe déjà).
   - Pas de doublon de compte admin en base.
   - Démarrage sans erreur (schéma déjà synchronisé, index déjà créés —
     `synchroniserSchema`/`creerIndexSpatiaux` sont idempotents).

4. **Double-lancement** (double-clic rapide sur le raccourci, ou relancer
   pendant que l'app tourne déjà) — vérifier que la fenêtre existante reprend
   le focus au lieu qu'une seconde fenêtre/erreur apparaisse (verrou
   mono-instance, `app.requestSingleInstanceLock()`).

5. **Désinstaller** — via `Uninstall GeoAino.exe` (ou Panneau de
   configuration) — vérifier :
   ```
   dir "%APPDATA%\GeoAino"
   ```
   Le dossier et tout son contenu doivent **toujours exister** après
   désinstallation (`deleteAppDataOnUninstall: false`). C'est le
   comportement attendu — ne jamais le « corriger ».

---

## 6. Mise à jour manuelle d'une installation existante

Il n'y a **pas de mécanisme d'auto-update** dans ce projet (hors périmètre du
plan initial — mono-poste, distribution par installateur uniquement). Pour
livrer une nouvelle version à un client :

1. Sur la machine de build, mettre à jour le code (`git pull`/merge de la
   branche voulue), puis reconstruire :
   ```bash
   npm run dist:desktop
   ```
2. Transmettre au client le nouveau `GeoAino Setup <version>.exe`
   (`desktop/dist-installer/`).
3. **Sur le poste client**, exécuter le nouvel installateur **par-dessus**
   l'installation existante (pas besoin de désinstaller d'abord) :
   - `allowToChangeInstallationDirectory: true` + NSIS réinstalle par-dessus
     `%LOCALAPPDATA%\Programs\GeoAino\` (code, ressources, `pg-portable`,
     runtime Next) sans toucher à `%APPDATA%\GeoAino\` (données).
   - Au relancement, `synchroniserSchema` (`prisma db push
     --accept-data-loss`) applique automatiquement toute évolution du schéma
     à la base existante, et `creerIndexSpatiaux` s'assure que les 8 index
     GIST spatiaux existent toujours.
4. **Pas besoin de réinstaller PostgreSQL/PostGIS** : `pgdata/` (le cluster
   déjà initialisé) est réutilisé tel quel — seul le binaire portable
   (`pg-portable/`, dans les ressources de l'app, pas dans `%APPDATA%`) est
   remplacé par la nouvelle version embarquée dans le nouvel installateur.

**Point de vigilance** : `--accept-data-loss` sur `db push` signifie qu'une
évolution de schéma qui supprimerait une colonne/table s'applique
**silencieusement** au prochain lancement après mise à jour — pas de prompt
de confirmation possible dans une app GUI empaquetée. Toujours vérifier une
migration de schéma manuellement (sur une copie de `pgdata` si le changement
est sensible) avant de livrer une mise à jour qui modifie `prisma/schema.prisma`.

---

## 7. Limitations connues (assumées, pas des bugs)

- **Mono-poste uniquement** — aucune concurrence réseau, PostgreSQL n'écoute
  que sur `127.0.0.1`. Pas conçu pour un usage multi-utilisateurs simultané.
- **`db push` au lieu de `migrate deploy`** — l'historique de migrations
  partagé avec le web a une lacune réelle (`limite_section` jamais créée par
  une migration) ; corriger l'historique toucherait aussi la base de
  production web. Décision explicite de l'utilisateur : le desktop bootstrap
  via `db push`, pas via l'historique de migrations. Voir le commentaire de
  `synchroniserSchema` (`desktop/src/main.ts`) pour le détail complet.
- **Mot de passe admin affiché une seule fois** — filet de secours écrit sur
  disque (`identifiants-initiaux.txt`), mais pas de récupération si le
  fichier est aussi perdu autrement que par réinitialisation complète de
  `pgdata` (perte de données).
- **Pas d'auto-update** — mise à jour = réinstallation manuelle (§6).
- **Licence liée à la machine, gestion manuelle par le vendeur** — pas
  d'auto-activation ni de portail client ; chaque licence est générée à la
  main par le vendeur via `desktop/scripts/licence/generer-licence.ts`
  (voir la section « Clé d'activation » ci-dessus).

---

## 8. Historique du chantier

Chantier mené en développement piloté par sous-agents (11 tâches du plan +
un correctif de bascule `migrate deploy` → `db push` en 7 commits + une
revue finale de branche en 3 commits). Fusionné dans `v8.0.0` (commits
`764a7ab..a7d57cb`, puis `87dac01` et `3d644d5`). Le ledger complet des
décisions prises pendant l'exécution (avec le coût de chacune si erronée)
n'est plus sur disque (nettoyé en fin de chantier, conformément au
processus) — l'historique git ci-dessus fait foi pour le détail des
correctifs.
