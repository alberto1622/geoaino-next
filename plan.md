détaille l'implémentation de la Phase 1 (schéma du job, worker, COPY PostGIS) sachant que les champs peut etre différent
suivant les fichiers

● Très bon point — l'hétérogénéité des champs est le piège qui fait exploser ce genre de pipeline. Voici la Phase 1
détaillée, avec le modèle de champs variables comme fil conducteur.

Principe directeur pour les champs variables : cœur typé + document JSONB

La règle d'or face à des sources hétérogènes (DXF DGID, SHP NICAD, GeoJSON tiers…) :

▎ Ne jamais essayer de tout typer en colonnes. On fige un cœur stable (ce que le pipeline produit toujours : géométrie,
▎ surface, empreinte, clés cadastrales quand elles existent) et on déverse tout le reste dans une colonne JSONB. Un
▎ nouveau format = zéro migration.

cad_parcelles
├─ COLONNES TYPÉES (cœur stable, indexées) ── geom, geom_hash, surface_m2,
│ syscolCommune, numSection,
│ numParcelle, nicad, repr point…
└─ properties JSONB ───────────────────────── TOUT le reste, tel quel
(libellés, attributs DBF, calques…)

---

1. Modèle de données

1.1 Le job d'import (suivi + reprise)

CadOperationLog existe déjà mais n'a ni phase ni clé de fichier ni progression fine. J'ajoute un modèle dédié (Prisma) :

model CadImportJob {
id String @id @default(cuid())
fileName String
fileKey String // fichier brut en object storage (rejouable)
sourceType String // "dxf" | "dgn" | "shp" | "geojson"
status String @default("queued") // queued|running|completed|failed|canceled
phase String? // read|polygonize|nicad|copy|promote
progress Int @default(0) // 0..100
totalBuilt Int @default(0)
totalInserted Int @default(0)
report Json? // DxfIngestionReport + métriques
error String? @db.Text
createdBy String?
createdAt DateTime @default(now())
updatedAt DateTime @updatedAt

    @@index([status])
    @@map("cad_import_jobs")

}

1.2 Le cœur typé + JSONB sur cad_parcelles

Migration SQL (la colonne geom reste Unsupported, gérée en SQL brut) :

ALTER TABLE "cad_parcelles" ADD COLUMN IF NOT EXISTS "properties" jsonb;
ALTER TABLE "cad_parcelles" ADD COLUMN IF NOT EXISTS "geomHash" text;
ALTER TABLE "cad_parcelles" ADD COLUMN IF NOT EXISTS "sourceJobId" text;

-- index pour requêter les attributs variables sans migration
CREATE INDEX IF NOT EXISTS cad_parcelles_props_gin ON "cad_parcelles" USING GIN ("properties");
-- idempotence : une même géométrie d'une même source ne rentre qu'une fois
CREATE UNIQUE INDEX IF NOT EXISTS cad_parcelles_hash_src
ON "cad_parcelles" ("geomHash", "sourceJobId");

1.3 Table de staging (le tampon de chargement massif)

Volontairement schema-light : tout ce qui varie va dans doc jsonb, on n'extrait en colonnes que ce qui sert au
dédoublonnage et à la jointure spatiale.

CREATE UNLOGGED TABLE IF NOT EXISTS "import_parcelle_staging" (
job_id text NOT NULL,
geom_hash text NOT NULL,
surface_m2 double precision,
repr_lng double precision, -- point représentatif (jointure commune)
repr_lat double precision,
num_section text, -- cœur cadastral si présent
num_parc5 text,
syscol text, -- rempli par la jointure spatiale
nicad text,
geom_json text, -- géométrie 4326 (GeoJSON) → convertie à la promotion
doc jsonb NOT NULL -- TOUS les champs variables (properties + textes)
);
CREATE INDEX IF NOT EXISTS staging_job ON "import_parcelle_staging" (job_id);

UNLOGGED = pas de WAL → chargement 2-3× plus rapide (c'est un tampon jetable).

1.4 Mapping déclaratif source → cœur (gère l'hétérogénéité proprement)

Plutôt que du if (format===…) éparpillé, une petite table de profils code → colonne cœur :

// src/lib/import/field-profiles.ts
type CoreField = "num_section" | "num_parc5" | "nicad" | "proprietaire";
export const FIELD_PROFILES: Record<string, Partial<Record<CoreField, string[]>>> = {
dxf: { num_section: ["numero_section"], num_parc5: ["numero_parcelle"], nicad: [] },
shp: { nicad: ["NICAD","CODE_NICAD"], num_section: ["CODESECTIO","SECTION"] },
geojson: { nicad: ["nicad","NICAD"] },
};
// extractCore(props, sourceType) → { num_section, num_parc5, nicad… } ; le reste → doc

Un nouveau format = une ligne de profil, pas une migration. Tout ce qui n'est pas mappé reste dans doc et reste
interrogeable (GIN).

---

2. La file d'attente : pg-boss (PostgreSQL, pas de Redis)

Tu as déjà Postgres → inutile d'ajouter Redis/BullMQ. pg-boss stocke la file dans la base : transactionnel, persistant,
reprise gratuite.

// src/lib/queue.ts
import PgBoss from "pg-boss";
let boss: PgBoss | null = null;
export async function getBoss() {
if (!boss) { boss = new PgBoss(process.env.DATABASE_URL!); await boss.start(); }
return boss;
}
export const IMPORT_QUEUE = "parcelle-import";

---

3. Le flux découplé

POST /api/upload-geo 1. écrit le fichier brut → fileKey (saveFileLocally, comme geo-storage.ts) 2. crée CadImportJob (status=queued) 3. boss.send(IMPORT_QUEUE, { jobId }) 4. répond { jobId } ◄── en < 1 s, plus aucun blob géant

Worker (process séparé : `node worker.ts`, hors event loop Next)
├─ read → ingestDxfToParcelles (profilage DXF_PROFILE) progress 10→50
├─ copy → COPY des parcelles dans import_parcelle_staging progress 50→70
├─ nicad → jointure spatiale ENSEMBLISTE (1 requête) progress 70→85
├─ promote → INSERT ... SELECT ... ON CONFLICT progress 85→98
└─ done → CadImportJob.status=completed + report progress 100

UI : poll GET /api/import-jobs/:id (ou SSE) → barre de progression
puis carte chargée par bbox (getParcellesByBbox existe déjà)

L'upload répond instantanément ; le calcul lourd vit dans un process séparé (le tokenize de 268 Mo ne bloque plus le
serveur web).

---

4. Le worker (cœur de la Phase 1)

// worker.ts (lancé à part : "node --import tsx worker.ts")
import { getBoss, IMPORT_QUEUE } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import { ingestDxfToParcelles } from "@/lib/parcelle-ingestion";
import { copyParcellesToStaging, resolveSyscolInStaging, promoteStaging } from "@/lib/import/load";
import { loadFile } from "@/lib/geo-storage";

const set = (id: string, d: object) => prisma.cadImportJob.update({ where: { id }, data: d });

(async () => {
const boss = await getBoss();
await boss.work(IMPORT_QUEUE, { teamConcurrency: 2 }, async ([job]) => {
const { jobId } = job.data as { jobId: string };
const rec = await prisma.cadImportJob.findUniqueOrThrow({ where: { id: jobId } });
try {
await set(jobId, { status: "running", phase: "read", progress: 10 });
const buf = await loadFile(rec.fileKey);
const { parcelles, report } = await ingestDxfToParcelles(buf, rec.fileName);

        await set(jobId, { phase: "copy", progress: 50, totalBuilt: parcelles.length });
        await copyParcellesToStaging(jobId, rec.sourceType, parcelles); // ← COPY (§5)

        await set(jobId, { phase: "nicad", progress: 70 });
        await resolveSyscolInStaging(jobId);                            // ← jointure SQL (§5)

        await set(jobId, { phase: "promote", progress: 85 });
        const inserted = await promoteStaging(jobId, rec.sourceType);   // ← INSERT…SELECT (§5)

        await set(jobId, { status: "completed", phase: "done", progress: 100,
                           totalInserted: inserted, report: report as object });
      } catch (e) {
        await set(jobId, { status: "failed", error: String(e) });
        throw e; // pg-boss garde la trace / retry possible
      }
    });

})();

Points clés : phases + progression persistées (l'UI lit ça), idempotence (le job peut être rejoué depuis fileKey),
concurrence bornée (teamConcurrency: 2 — c'est CPU-bound, on ne sature pas la machine).

---

5. Le chargement PostGIS (COPY → jointure → promotion)

5.1 COPY en flux vers le staging (le gain de débit)

Prisma ne fait pas de COPY → client pg brut + pg-copy-streams. On stream les parcelles en CSV, sans jamais matérialiser
un gros buffer.

// src/lib/import/load.ts
import { Pool } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extractCore } from "./field-profiles";
import type { ParcelleCandidate } from "@/lib/parcelle-ingestion";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const csv = (s: string) => `"${s.replace(/"/g, '""')}"`; // quote CSV/JSON sûr

export async function copyParcellesToStaging(
jobId: string, sourceType: string, parcelles: ParcelleCandidate[],
) {
const client = await pool.connect();
try {
const stream = client.query(copyFrom(
`COPY "import_parcelle_staging"
         (job_id, geom_hash, surface_m2, repr_lng, repr_lat,
          num_section, num_parc5, syscol, nicad, geom_json, doc)
         FROM STDIN WITH (FORMAT csv)`));

      // générateur : 1 ligne CSV par parcelle, en flux (mémoire bornée)
      const rows = Readable.from((function* () {
        for (const p of parcelles) {
          const core = extractCore(p, sourceType);          // mapping déclaratif
          const doc = JSON.stringify({                       // ← champs VARIABLES
            numero: p.numero, numeroLot: p.numeroLot,
            proprietaire: p.proprietaire, denomination: p.denomination,
            autresTextes: p.autresTextes, isPiscine: p.isPiscine,
            ...core.extra,                                   // attributs source bruts
          });
          yield [
            jobId, p.geomHash, p.surfaceM2,
            p.repPoint4326[0], p.repPoint4326[1],
            core.num_section ?? "", core.num_parc5 ?? "", "", core.nicad ?? "",
            JSON.stringify(p.geomGeoJson4326), doc,
          ].map((v) => csv(String(v ?? ""))).join(",") + "\n";
        }
      })());

      await pipeline(rows, stream);
    } finally { client.release(); }

}

PostGIS ingère des centaines de milliers de lignes en quelques secondes par COPY, là où des INSERT unitaires prendraient
des minutes.

5.2 Jointure spatiale ensembliste (le gros gain serveur)

Au lieu de 113k allers-retours, une seule requête : ST_Contains indexé pour tous, le repli near uniquement pour les
non-résolus.

-- 1) contenance exacte (index GiST via &&), pour tous les points d'un coup
UPDATE "import_parcelle_staging" s
SET syscol = c."syscolPadded"
FROM "cad_communes_2026" c
WHERE s.job_id = $1 AND s.syscol = ''
AND c.geom && ST_SetSRID(ST_MakePoint(s.repr_lng, s.repr_lat),4326)
AND ST_Contains(c.geom, ST_SetSRID(ST_MakePoint(s.repr_lng, s.repr_lat),4326));

-- 2) repli proximité 50 m, SEULEMENT pour le reste (≪ 113k au lieu de = 113k)
UPDATE "import_parcelle_staging" s
SET syscol = c."syscolPadded"
FROM LATERAL (
SELECT "syscolPadded" FROM "cad_communes_2026" c
WHERE ST_DWithin(c.geom::geography,
ST_SetSRID(ST_MakePoint(s.repr_lng,s.repr_lat),4326)::geography, 50)
ORDER BY c.geom <-> ST_SetSRID(ST_MakePoint(s.repr_lng,s.repr_lat),4326) LIMIT 1
) c
WHERE s.job_id = $1 AND s.syscol = '';

-- 3) NICAD = syscol(8)+section(3)+parcelle(5) quand les 3 sont présents
UPDATE "import_parcelle_staging" SET nicad = syscol || num_section || num_parc5
WHERE job_id = $1 AND syscol <> '' AND num_section <> '' AND num_parc5 <> '';

5.3 Promotion (staging → table finale, idempotente)

INSERT INTO "cad_parcelles"
("syscolCommune","numSection","numParcelle","version","nicad","statut",
"superficie","longitude","latitude","geom","geomHash","sourceJobId","properties")
SELECT
NULLIF(syscol,''), NULLIF(num_section,''), NULLIF(num_parc5,''), '2026',
NULLIF(nicad,''),
CASE WHEN nicad <> '' THEN 'actif' ELSE 'sans_nicad' END,
surface_m2, repr_lng, repr_lat,
ST_Multi(ST_GeomFromGeoJSON(geom_json)), -- 4326, coercition MultiPolygon
geom_hash, job_id, doc -- ← champs variables conservés
FROM "import_parcelle_staging"
WHERE job_id = $1
ON CONFLICT ("geomHash","sourceJobId") DO NOTHING; -- rejouable sans doublon

DELETE FROM "import_parcelle_staging" WHERE job_id = $1; -- nettoyage du tampon

ON CONFLICT DO NOTHING = idempotence : relancer un job ne duplique rien. La géométrie est convertie en base
(ST_GeomFromGeoJSON), pas en JS.

---

6. API & UI (minimal)

- POST /api/upload-geo → écrit fileKey, crée le job, boss.send, répond { jobId }.
- GET /api/import-jobs/[id] → { status, phase, progress, totalBuilt, totalInserted, report } (poll 1 s, ou SSE).
- Carte : plus jamais le GeoJSON complet ; getParcellesByBbox (déjà présent) charge la fenêtre visible.

---

7. Ce que cette Phase 1 te garantit

┌─────────────────────┬────────────────────────────────────────────────────────────────────────────┐
│ Propriété │ Comment │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ UI ne tourne plus │ upload répond en < 1 s ; calcul hors requête │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Champs hétérogènes │ cœur typé + properties JSONB + profils de mapping → 0 migration par format │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Débit │ COPY (staging UNLOGGED) + jointure ensembliste + conversion géom en SQL │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Idempotence/reprise │ fileKey rejouable + ON CONFLICT (geomHash, sourceJobId) │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Observabilité │ phases + progression dans CadImportJob, DXF_PROFILE côté worker │
├─────────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ Persistance │ parcelles en base, réutilisables (carte, export, QA) sans recalcul │
└─────────────────────┴────────────────────────────────────────────────────────────────────────────┘

---

Nouvelles dépendances : pg-boss, pg, pg-copy-streams (légères, toutes adossées au Postgres existant — aucune nouvelle
infra).

Veux-tu que je commence à coder cette Phase 1 dans l'ordre de risque croissant — (1) migrations + staging, (2) load.ts
(COPY + jointure + promotion) testable en isolation sur un job, (3) worker + file, (4) API/UI — ou que je te livre
d'abord un document de conception (docs/) que tu fais valider avant implémentation ?

● Ran 1 stop hook (ctrl+o to expand)
⎿ Stop hook error: Failed with non-blocking status code: Exception calling "PlaySync" with "0" argument(s): "The
file located at C:/Users/bakho/.claude/song/finish.mp3 is not
a valid wave file."
At line:1 char:1

- (New-Object Media.SoundPlayer 'C:/Users/bakho/.claude/song/finish.mp3 ...
- ```
    + CategoryInfo          : NotSpecified: (:) [], MethodInvocationException
    + FullyQualifiedErrorId : InvalidOperationException
  ```

✻ Churned for 2m 20s

※ recap: Goal: make large DXF cadastral imports work. We fixed the polygonization hang and capped the web response; I just
detailed a Phase 1 async-job architecture (queue, worker, COPY into PostGIS) handling variable fields. Next: you decide
wh

claude --resume f53fe08b-9f98-4578-b2c6-074a281bba0f
