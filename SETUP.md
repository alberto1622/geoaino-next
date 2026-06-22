# GEO-AINO SUPREME™ v5.0 — Setup Guide

## Stack
- **Next.js 16** (App Router, fullstack)
- **PostgreSQL** (via Docker)
- **Prisma 5** (ORM)
- **NextAuth.js v5** (authentification email/password)
- **Leaflet** (cartes interactives)
- **Recharts** (graphiques)
- **TailwindCSS v4** (styles)
- **OpenAI GPT-4o** (IA)

## Prérequis
- Node.js 20+
- Docker Desktop
- PostgreSQL (via Docker ou local)

## Installation

### 1. Cloner et installer

```bash
cd geoaino-next
npm install
```

### 2. Démarrer PostgreSQL via Docker

```bash
docker-compose up -d
```

Ce command démarre :
- PostgreSQL sur le port **5432**
- pgAdmin sur **http://localhost:5050** (admin@geoaino.sn / admin)

### 3. Configurer les variables d'environnement

Copier `.env.local` et remplir les valeurs :

```bash
cp .env.local .env.local.bak
```

```env
# PostgreSQL
DATABASE_URL="postgresql://postgres:password@localhost:5432/geoaino_supreme"

# NextAuth
NEXTAUTH_SECRET="votre-secret-aleatoire-min-32-chars"
NEXTAUTH_URL="http://localhost:3000"

# OpenAI (optionnel - rapport IA)
OPENAI_API_KEY="sk-..."

# Uploads (dossier local pour les fichiers GeoJSON)
UPLOADS_DIR="./uploads/geojson"
```

Générer un secret NextAuth :
```bash
openssl rand -base64 32
```

### 4. Créer le schéma de base de données

```bash
npx prisma migrate dev --name init
```

### 5. Créer un compte admin

```bash
npx ts-node scripts/create-admin.ts
# OU via l'API :
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin","email":"","password":"admin123"}'
```

### 6. Démarrer le serveur de développement

```bash
npm run dev
```

Ouvrir **http://localhost:3000**

## Structure du projet

```
src/
├── app/                    # Pages (App Router)
│   ├── page.tsx            # Accueil — upload fichiers
│   ├── dashboard/          # Tableau de bord + statistiques
│   ├── history/            # Historique des analyses
│   ├── reports/            # Rapports IA
│   ├── map/[analysisId]/   # Carte interactive avec erreurs
│   ├── topology/[id]/      # Visionneuse topologique
│   ├── login/              # Authentification
│   └── api/                # Route Handlers (API REST)
│       ├── upload-geo/     # Upload SHP/GeoJSON/KML/CSV
│       ├── analyses/       # CRUD analyses
│       ├── ai/chat/        # Chat IA
│       ├── reports/        # Rapports
│       └── auth/           # NextAuth
├── components/             # Composants React
│   ├── HomeClient.tsx      # Page d'accueil
│   ├── DashboardClient.tsx # Dashboard
│   ├── HistoryClient.tsx   # Historique
│   ├── MapAnalysisClient.tsx # Carte analyse
│   ├── LeafletMap.tsx      # Composant carte Leaflet
│   └── ui/                 # Composants UI (boutons, cards...)
├── lib/
│   ├── prisma.ts           # Client Prisma
│   ├── auth.ts             # NextAuth config
│   ├── geo-engine.ts       # Moteur analyse topologique
│   ├── llm.ts              # Client OpenAI
│   └── utils.ts            # Utilitaires
prisma/
└── schema.prisma           # Schéma PostgreSQL
```

## Formats de fichiers supportés
- **SHP** — Shapefiles (sélectionner .shp + .dbf + .prj ensemble)
- **GeoJSON** — Format GeoJSON standard
- **ZIP** — Archive contenant SHP ou GeoJSON
- **KML** — Google Earth / Maps
- **CSV** — Avec colonnes lat/lon
- **DXF** — AutoCAD/Microstation (pipeline d'ingestion parcelles : calques, NICAD, jointures)
- **DGN** — Microstation. **v7** lu directement par GDAL. **v8** : nécessite un
  convertisseur externe configuré (voir ci-dessous) ; sinon un message invite à
  convertir manuellement le fichier.

### DGN v8 → DXF (convertisseur externe configurable)
⚠️ **Important** : aucun composant embarqué ne lit le **DGN v8** (Microstation V8) :
GDAL standard ne gère que le DGN v7, et **ODA File Converter ne lit que DWG/DXF, pas le
DGN**. Lire un DGN v8 exige un outil tiers capable de le décoder.

Le serveur délègue donc la conversion à une commande externe que vous configurez. Au
upload d'un `.dgn`, si elle est configurée, le serveur convertit DGN→DXF puis route vers
le pipeline DXF complet ; sinon, repli automatique sur GDAL (DGN v7) + message d'aide.

```env
# Exécutable du convertisseur (active la fonctionnalité)
DGN_TO_DXF_BIN="C:\\chemin\\vers\\convertisseur.exe"
# Gabarit d'arguments ; {input}=DGN source, {output}=DXF cible (défaut ci-dessous)
DGN_TO_DXF_ARGS="-f DXF -skipfailures {output} {input}"
```

**Backends possibles (à installer/licencier côté serveur) :**
1. **GDAL compilé avec le driver DGNv8** (basé sur les librairies ODA — adhésion ODA
   requise pour le SDK ; non inclus dans OSGeo4W/conda par défaut). Une fois disponible :
   ```env
   DGN_TO_DXF_BIN="C:\\gdal-dgnv8\\ogr2ogr.exe"
   DGN_TO_DXF_ARGS="-f DXF -skipfailures {output} {input}"
   ```
   Vérifier le driver : `ogrinfo --formats | grep -i dgnv8`.
2. **MicroStation en batch** via un script wrapper que vous écrivez (`.bat`/`.sh`)
   prenant `{input}` et `{output}` :
   ```env
   DGN_TO_DXF_BIN="C:\\scripts\\mstn-dgn2dxf.bat"
   DGN_TO_DXF_ARGS="{input} {output}"
   ```

## Types d'erreurs détectées
| Type | Description |
|------|-------------|
| OVERLAP | Chevauchement entre parcelles |
| GAP | Espace vide entre parcelles |
| SLIVER | Parcelle résiduelle/très allongée |
| DUPLICATE | NICAD dupliqué |
| INVALID_GEOM | Géométrie invalide |
| BOUNDARY_CROSS | Croisement limite administrative |
| MISSING_NICAD | NICAD manquant ou < 8 chars |
| SELF_INTERSECT | Auto-intersection |


## Module Cadastre (NICAD) — intégration de vericad

Le module « Cadastre » (gestion des NICAD, Syscol 2013 → 2026) est intégré
nativement sous le segment de routes `src/app/cadastre/` et accessible via le
lien **Cadastre** de la barre de navigation (`/cadastre/dashboard`).

### Dépendances supplémentaires
```bash
npm install archiver            # génération des ZIP shapefile (export)
npm install -D @types/archiver
npm install -D mysql2           # uniquement pour l'ETL ci-dessous (source MySQL)
```

### Schéma de base de données
Les tables du module sont préfixées `cad_*` (modèles Prisma `Cad*`) et créées par
la migration `prisma/migrations/20260618144113_add_cadastre_module`. Les colonnes
géométriques `geom` sont en PostGIS (SRID 4326) avec index GIST.

```bash
npx prisma migrate deploy   # applique la migration
npx prisma generate         # régénère le client (types Cad*)
```

### Migration des données réelles (ETL MySQL → Postgres)
Transfère communes, sections, parcelles (~229k), NICAD, historique et
correspondances depuis la base MySQL de vericad. Les `geojson` sont convertis en
géométries PostGIS.

```bash
# 1) Variables d'environnement (dans .env ou l'environnement)
#    DATABASE_URL=postgres://...        (cible geoaino, déjà configurée)
#    VERICAD_MYSQL_URL=mysql://user:pass@host:3306/vericad   (source)

# 2) Lancer l'ETL (--fresh vide les tables cad_* avant import)
npx tsx scripts/migrate-vericad.ts --fresh
```

### Vérification rapide
- `/cadastre/dashboard` : statistiques (NICAD, parcelles ≈ 229k, communes ≈ 552).
- `/cadastre/verification` : saisir un NICAD 16 caractères → décomposition 8·3·5.
- `/cadastre/generation` : commune → section → NICAD généré.
- `/cadastre/carte` : parcelles par commune (Leaflet), identification au clic.
- Les actions protégées (génération, basculement, migration, import) exigent une
  session next-auth ; chaque opération est journalisée dans `cad_operations_log`
  (visible sur `/cadastre/historique`).
