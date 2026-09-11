# Bureau autonome : geoaino-next packagé en application desktop — design

Date : 2026-09-11

## Problème

geoaino-next est aujourd'hui une application web Next.js server-rendue,
adossée à un unique PostgreSQL+PostGIS partagé (référentiel organisationnel
commun — cf. les modules cadastre, historique, import DXF/shapefile,
vérification de bornes). Ce modèle suppose un serveur central accessible.

Objectif de cette spec : permettre de **vendre/distribuer geoaino-next comme
un logiciel de bureau autonome** à des organismes tiers (mairies, bureaux de
géomètres privés) qui n'ont ni accès au serveur central de geoaino, ni
nécessairement de connexion internet fiable, et qui n'opèrent pas
eux-mêmes d'infrastructure PostgreSQL/PostGIS. Chaque installation doit
fonctionner de façon totalement indépendante, avec ses propres données
cadastrales locales.

## Décisions de cadrage (issues du brainstorming)

- **Motivation** : distribution/vente à des tiers — pas un besoin de terrain
  hors-ligne pour les équipes internes de geoaino.
- **Multi-poste** : mono-poste. Une installation = un poste = pas de partage
  réseau local entre plusieurs PC chez un même client. Ce point simplifie
  fortement le design (aucune synchronisation, aucune gestion de
  concurrence réseau à prévoir).
- **Périmètre fonctionnel** : parité complète avec la version web — import
  DXF massif, polygonisation par tuiles, topologie/réconciliation,
  génération cadastre, export, et le module de vérification de bornes
  (y compris import PDF/OCR et la voie « Photo » récemment livrée). Aucune
  fonctionnalité n'est reléguée côté serveur central.

## Portée

- **Dans le périmètre** :
  - Empaquetage Electron faisant tourner, en local et sans internet, le
    serveur Next.js existant (`output: standalone`) adossé à un vrai
    PostgreSQL+PostGIS portable embarqué (pas une réécriture vers un autre
    moteur spatial).
  - Orchestration du cycle de vie : premier lancement (initialisation de la
    base), lancements suivants, migrations Prisma automatiques, arrêt
    propre.
  - Rendre les dépendances optionnelles de l'OCR (`pdfjs-dist`,
    `tesseract.js`, `@napi-rs/canvas`) réellement fonctionnelles hors-ligne
    dans le build empaqueté (elles sont aujourd'hui chargées
    dynamiquement et tolérées absentes en web — sur le bureau autonome,
    leur présence et leur fonctionnement sont requis).
  - Dégradation propre (pas de crash) de la fonctionnalité IA
    (`src/lib/llm.ts`, `/api/ai/chat`) en l'absence de connexion internet.
  - Cible **Windows uniquement** (poste de développement et contexte client
    présumés Windows ; à revoir si un client macOS/Linux se présente).
- **Hors scope** (explicitement exclu de cette spec, à traiter plus tard si
  besoin) :
  - Synchronisation multi-poste / réseau local chez un client.
  - Auto-update en ligne (`electron-updater` ou équivalent) — v1 se
    distribue par nouvel installateur, les migrations Prisma absorbent
    l'évolution du schéma sur les données déjà présentes chez le client.
  - Signature de code / suppression de l'avertissement Windows SmartScreen
    — décision business (achat de certificat), pas technique.
  - Licence / activation commerciale (contrôle de qui peut utiliser
    l'installation vendue).
  - Cibles macOS / Linux.

## Architecture

Trois processus cohabitent dans l'application Electron :

1. **Processus principal Electron (orchestrateur)** — au démarrage :
   initialise si besoin le cluster PostgreSQL local, le démarre, applique
   les migrations Prisma, démarre le serveur Next.js en sous-processus,
   puis ouvre une fenêtre pointée sur `http://127.0.0.1:<port>`. À la
   fermeture : arrête les deux sous-processus dans l'ordre inverse.
2. **PostgreSQL/PostGIS local** — binaires portables embarqués (archives
   officielles, pas d'installateur), cluster de données sous
   `%APPDATA%\GeoAino\pgdata`, écoute uniquement sur `127.0.0.1`. Du point
   de vue de Prisma et de tout le SQL applicatif (y compris le SQL brut
   `ST_*` existant), c'est un Postgres comme un autre — **aucun changement
   de requête, de schéma, ou de logique métier**.
3. **Serveur Next.js** (`output: "standalone"`) — même code applicatif,
   mêmes routes API, même client Prisma, lancé comme process Node enfant.
4. **Fenêtre Electron** — agit comme le navigateur, pointée sur le
   localhost. Aucun changement côté React/UI.

Ce découpage minimise le risque : toute la nouveauté est dans
l'orchestration autour du code existant, pas dans le code lui-même.

## Cycle de démarrage

**Premier lancement** (`%APPDATA%\GeoAino\pgdata` absent) :

1. Localisation des binaires PostgreSQL+PostGIS portables embarqués dans
   les ressources de l'app.
2. `initdb` crée le cluster local (utilisateur local, pas d'authentification
   réseau — écoute restreinte à `127.0.0.1`).
3. `pg_ctl start` sur un port choisi dynamiquement dans une plage réservée
   (test séquentiel de ports libres, pour éviter tout conflit avec un
   Postgres déjà installé sur la machine du client).
4. Création de la base applicative + `CREATE EXTENSION postgis;`.
5. `prisma migrate deploy` — rejoue l'historique de migrations existant, à
   l'identique de la production.
6. Seed d'un compte ADMIN initial, pour que l'opérateur puisse se connecter
   dès le premier lancement.
7. Démarrage du serveur Next.js standalone, puis ouverture de la fenêtre.

**Lancements suivants** : étapes 1-2 et 6 sautées (cluster et compte déjà
présents) ; `pg_ctl start` direct, `prisma migrate deploy` (idempotent —
n'applique que les migrations nouvellement livrées par une mise à jour),
puis Next.js + fenêtre. L'écran de chargement existant (logo, point
lumineux circulant) masque ce délai de démarrage.

## Gestion des erreurs

- **Port local déjà occupé** (Postgres ou Next) → bascule automatique sur
  le port suivant de la plage réservée ; jamais d'échec silencieux.
- **`pg_ctl start` échoue** avec un `postmaster.pid` orphelin (arrêt sale
  précédent, process tué de force) → détection du cas (process mort mais
  verrou présent), nettoyage automatique, nouvelle tentative. Si l'échec
  persiste : message d'erreur explicite à l'écran plutôt qu'une app qui ne
  s'ouvre jamais.
- **Migration Prisma échouée** → l'app ne s'ouvre pas sur une base à moitié
  migrée ; message clair + logs Postgres/Prisma écrits dans
  `%APPDATA%\GeoAino\logs\`, consultables pour le support.
- **Fermeture de l'app** (croix, ou crash du process principal) → un
  handler `before-quit` arrête proprement `pg_ctl stop` avant de tuer le
  process Next, pour ne jamais laisser le cluster dans un état incohérent
  au prochain démarrage.

## Empaquetage & distribution

- **electron-builder**, cible NSIS (installateur Windows).
- **Contenu embarqué** : binaires PostgreSQL+PostGIS portables
  (~150-250 Mo), build Next.js `standalone`, moteur Prisma compilé pour
  Windows (`binaryTargets` à ajouter dans `schema.prisma`, en plus de celui
  déjà utilisé pour le serveur web — coexistence dans le même schéma),
  runtime Electron (~150-200 Mo). Installateur final estimé dans les
  400-600 Mo.
- **Risque technique identifié — traçage des dépendances optionnelles de
  l'OCR** : `ocr.ts` et `pdfTableauTexte.ts` chargent `pdfjs-dist`,
  `tesseract.js` et `@napi-rs/canvas` via un `import()` à **spécificateur
  variable**, délibérément pour empêcher leur résolution statique par le
  bundler (leur absence est tolérée en web). En mode `output: standalone`,
  le traçage de fichiers de Next ne voit pas ces dépendances par analyse
  statique et risque de ne pas les inclure dans le bundle — alors qu'ici
  elles doivent réellement fonctionner (parité complète = OCR qui marche
  sans connexion). À corriger via `outputFileTracingIncludes` ou une étape
  de build copiant explicitement ces `node_modules` dans les ressources
  Electron, et à **vérifier par un test d'empaquetage réel**, pas en
  confiance sur la config.
- **tesseract.js hors-ligne** : par défaut, il va chercher son *worker*,
  son *core* et ses données de langue sur un CDN. Il faut embarquer ces
  fichiers localement et forcer les chemins (`workerPath`/`corePath`/
  `langPath`) — sinon l'OCR de la voie « Photo » (livrée juste avant cette
  spec) casse silencieusement dès que la machine est hors-ligne.
- **Mises à jour** : pas d'auto-update en ligne en v1 (hors scope, cf.
  plus haut) — nouvelle version = nouvel installateur, `prisma migrate
  deploy` absorbe l'évolution du schéma sur les données déjà présentes
  chez le client.
- **Signature de code** : hors scope technique de cette spec (décision
  business) — noté ici pour mémoire, l'installateur non signé déclenchera
  l'avertissement SmartScreen tant que non traité.

## Changements dans le code existant

- `next.config.ts` : ajouter `output: "standalone"` et les inclusions de
  traçage explicites pour `pdfjs-dist`/`tesseract.js`/`@napi-rs/canvas`
  (cf. risque ci-dessus).
- `prisma/schema.prisma` : ajouter le `binaryTarget` Windows aux côtés de
  celui du serveur web.
- **Configuration injectée au runtime**, pas de `.env` statique :
  `DATABASE_URL` (port Postgres local choisi dynamiquement),
  `NEXTAUTH_URL` (port Next local), `NEXTAUTH_SECRET` (généré une fois à
  l'installation, persisté dans `%APPDATA%\GeoAino`). Le process principal
  Electron injecte ces valeurs dans l'environnement du sous-processus
  Next au lancement.
- `src/lib/llm.ts` : dégradation propre en l'absence de réseau (message
  clair côté UI plutôt qu'une erreur brute qui remonte jusqu'au client).
- **Nouveau** : un dossier `desktop/` dans ce même dépôt (pas un dépôt
  séparé — partage le code applicatif sans duplication) portant le
  process principal Electron, le script d'orchestration Postgres, et la
  configuration `electron-builder`.

L'authentification (`CredentialsProvider`, email/mot de passe via
`bcryptjs`) ne nécessite aucune adaptation : elle ne dépend d'aucun
service OAuth externe et fonctionne déjà entièrement hors-ligne.

## Tests / validation

Ce projet n'a pas de framework de test automatisé (style
`scripts/test-verif.ts`, scripts `tsx` ad hoc) — même philosophie ici : un
script de fumée pour l'empaquetage (vérifie que les ressources attendues
sont bien présentes dans le build produit), et une checklist manuelle
pour le cycle de vie :

- premier lancement sur `%APPDATA%` vierge → base initialisée, compte
  ADMIN créé, application utilisable ;
- fermeture puis relance → les données du client persistent, redémarrage
  rapide ;
- `postmaster.pid` orphelin (process tué de force) → récupération
  automatique au relancement ;
- import PDF + OCR voie « Photo » → fonctionnent sans connexion internet ;
- fonctionnalité IA sans connexion → message clair, pas de crash ;
- **désinstallation** : ne doit **pas** supprimer silencieusement
  `%APPDATA%\GeoAino\pgdata` (données cadastrales du client) — à
  documenter explicitement ; une suppression complète, si un jour
  souhaitée, doit être une action séparée et délibérée.

## Risques résiduels à garder en tête

- Taille et temps de premier démarrage (initialisation Postgres + éventuel
  antivirus scrutant un nouvel exécutable) — à mesurer tôt dans
  l'implémentation, pas en fin de projet.
- Performance du pipeline géospatial (JSTS, polygonisation par tuiles sur
  des jeux de dizaines de milliers de parcelles, cf. les retours de
  terrain DXF documentés dans `docs/CONCEPTS-TRAITEMENT-DXF.md`) sur du
  matériel client potentiellement modeste, sans plus la mutualisation
  d'un serveur dédié.
- Disponibilité réelle d'une archive PostgreSQL+PostGIS portable pour
  Windows, dans la version majeure utilisée en production — à valider en
  tout début d'implémentation (spike ciblé), avant d'investir dans le
  reste de l'orchestration Electron.
