# Jointure sections pour la construction du NICAD (shapefile page d'accueil) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le chemin shapefile → `Analysis` de la page d'accueil (`job.kind
=== "parcelles"`, `src/lib/import/run-shapefile-job.ts`, livré par le plan
`2026-08-12-home-shapefile-import-job.md`) ne construit actuellement aucun
NICAD — les parcelles gardent tel quel ce qu'il y a dans le `.dbf`. Ce plan
ajoute une résolution automatique : pour chaque parcelle sans NICAD valide,
une jointure spatiale sur `limite_section` (la table derrière
`/cadastre/sections`) donne à la fois le Syscol (8 chiffres) et le numéro de
section (3 chiffres) en une seule requête, puis le NICAD est construit avec
le numéro de parcelle déjà présent dans le `.dbf` (aucune attribution par
incrémentation ici — hors périmètre, décision explicite).

**Architecture :** Nouvelle jointure batch `getSectionsForPoints` dans
`src/lib/cadastre/sections-data.ts`, calquée exactement sur
`getSyscols2026ForPoints` (`src/lib/cadastre/data.ts`) — contenance stricte
par lots (`ST_Contains`) puis repli de proximité 50 m (`ST_DWithin`) pour les
points non résolus — mais interrogeant `limite_section` au lieu de
`cad_communes_2026`. Nouvelle étape pure-DB `assignSectionNicad` dans un
nouveau fichier `src/lib/cadastre/assign-section-nicad.ts` (symétrique de
`assign-nicad-2026.ts`) : garde tout NICAD déjà valide inchangé, sinon
résout la section par jointure et construit le NICAD via `buildNicad`
(existant, `src/lib/nicad.ts`) si un numéro de parcelle exploitable est
trouvé dans les propriétés `.dbf`. Branchée dans la branche
`job.kind === "parcelles"` de `run-shapefile-job.ts`, juste avant l'appel à
`finishParcellesJob`.

**Tech Stack :** Next.js 16 (App Router), Prisma + SQL brut PostGIS
(`ST_Contains`/`ST_DWithin`), `@turf/turf` (déjà dépendance), TypeScript
strict.

## Global Constraints

- **Ne jamais écraser un NICAD déjà valide.** Un NICAD présent dans le
  `.dbf` qui passe `validateNicadFormat` (16 chiffres, format correct) n'est
  JAMAIS reconstruit — cette étape ne comble que les trous (NICAD absent ou
  mal formé), décision explicite prise avec l'humain.
- **Pas d'attribution automatique de numéro de parcelle par incrémentation.**
  Si aucun numéro de parcelle exploitable n'est trouvé dans les propriétés
  `.dbf` d'une parcelle (via les mêmes alias que `PARCELLE_TARGET_FIELDS`,
  `src/lib/import/field-mapping.ts` — `numparcell`, `num_parce`, `numparce`,
  `numparcelle`), le NICAD n'est PAS construit pour cette parcelle-là (reste
  tel quel), même si sa section a été résolue. C'est un choix explicite —
  `fillMissingNicadForSection` (incrémentation + plus proche voisin) existe
  déjà ailleurs pour ce cas, hors périmètre de ce plan.
- **Périmètre : uniquement le chemin `job.kind === "parcelles"` de
  `run-shapefile-job.ts`** (page d'accueil → `Analysis` → `/map`). Ne pas
  toucher aux branches `"sections"` / `"cad-parcelles"`/`"cad-sections"` du
  même fichier, ni aux shapefiles de `/cadastre/import` ou de
  `SectionsClient.tsx` (plan précédent, déjà mergé, hors périmètre ici).
- **`getSectionsForPoints` doit suivre exactement le même pattern à deux
  passes que `getSyscols2026ForPoints`** (contenance stricte par lots, puis
  repli de proximité 50 m uniquement sur les points non résolus par la
  passe 1) — ne pas simplifier en une seule passe, la cohérence avec le
  pattern déjà établi (et déjà correct pour les grands volumes) prime.
- Ce projet n'a pas de framework de test (pas de vitest/jest —
  `package.json` n'a que `eslint`). Vérification : `npx tsc --noEmit -p .`
  et `npx eslint <fichiers modifiés>` après chaque tâche. Pas de
  serveur/BD disponible dans cet environnement pour vérifier une vraie
  jointure spatiale en conditions réelles — à documenter comme limitation
  acceptée, pas comme échec, et à vérifier manuellement avant mise en
  production.
- Deux erreurs `Cannot find name 'RouteContext'` sont déjà connues et
  acceptées dans ce worktree (`src/app/api/import-jobs/[id]/route.ts` et
  `.../[id]/cancel/route.ts`) — limitation d'environnement, pas un défaut
  de code. Ne pas les re-signaler.

---

### Task 1: `getSectionsForPoints` — jointure spatiale batch sur `limite_section`

**Files:**
- Modify: `src/lib/cadastre/sections-data.ts`

**Interfaces:**
- Produces: `getSectionsForPoints(points: Array<{ lng: number; lat: number }>, db?: Db): Promise<Array<{ syscolCommune: string | null; numSection: string | null; commune: string | null; approx: boolean }>>` (même ordre que `points` en entrée, un élément par point).

- [ ] **Step 1: Lire `getSyscols2026ForPoints` en entier**

Ouvrir `src/lib/cadastre/data.ts` et lire `getSyscols2026ForPoints` (et sa
constante `SYSCOL_RESOLVE_CHUNK`) en entier — c'est le modèle EXACT à suivre :
deux passes (`$queryRaw` avec un payload JSON de points groupés par lots,
`LEFT JOIN LATERAL` avec `ST_Contains` puis `ST_DWithin(...::geography, 50)`
pour les non-résolus de la passe 1).

- [ ] **Step 2: Ajouter `getSectionsForPoints` dans `sections-data.ts`**

Ajouter, près des autres fonctions d'accès `limite_section` de ce fichier :

```ts
// Taille de lot pour la résolution spatiale section — même volumétrie que
// `SYSCOL_RESOLVE_CHUNK` (data.ts), configurable indépendamment au besoin.
const SECTION_RESOLVE_CHUNK = Number(process.env.SECTION_RESOLVE_CHUNK || 20000);

/**
 * Résout, pour chaque point (lng/lat, EPSG:4326), la section `limite_section`
 * le CONTENANT (`ST_Contains`) ; à défaut, la section la plus proche dans une
 * tolérance de 50 m (`approx = true`), même logique que
 * `getSyscols2026ForPoints` (`data.ts`) pour les communes 2026. Renvoie
 * syscol ET numéro de section en une seule jointure (contrairement à la
 * jointure commune, `limite_section` porte les deux). Au-delà de la
 * tolérance, aucune section n'est attribuée (tous les champs `null`).
 */
export async function getSectionsForPoints(
  points: Array<{ lng: number; lat: number }>,
  db: Db = prisma,
): Promise<Array<{ syscolCommune: string | null; numSection: string | null; commune: string | null; approx: boolean }>> {
  if (points.length === 0) return [];

  const result: Array<{ syscolCommune: string | null; numSection: string | null; commune: string | null; approx: boolean }> =
    points.map(() => ({ syscolCommune: null, numSection: null, commune: null, approx: false }));

  // ── Passe 1 : contenance stricte, par lots (TOUS les points). ──────────────
  const unresolved: number[] = [];
  for (let start = 0; start < points.length; start += SECTION_RESOLVE_CHUNK) {
    const slice = points.slice(start, start + SECTION_RESOLVE_CHUNK);
    const payload = JSON.stringify(slice.map((p, k) => ({ i: start + k, lng: p.lng, lat: p.lat })));

    const rows = await db.$queryRaw<
      Array<{ i: number; syscol: string | null; numSection: string | null; commune: string | null }>
    >`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, hit."syscolCommune" AS syscol, hit."numSection" AS "numSection", hit."commune" AS commune
      FROM pts
      LEFT JOIN LATERAL (
        SELECT s."syscolCommune", s."numSection", s."commune"
        FROM "limite_section" s
        WHERE s.geom IS NOT NULL AND s.geom && pts.geom AND ST_Contains(s.geom, pts.geom)
        LIMIT 1
      ) hit ON true
    `;

    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscolCommune: r.syscol, numSection: r.numSection, commune: r.commune, approx: false };
      else unresolved.push(i);
    }
  }

  // ── Passe 2 : repli de proximité (50 m), uniquement pour les non résolus. ──
  for (let start = 0; start < unresolved.length; start += SECTION_RESOLVE_CHUNK) {
    const idxSlice = unresolved.slice(start, start + SECTION_RESOLVE_CHUNK);
    const payload = JSON.stringify(
      idxSlice.map((i) => ({ i, lng: points[i].lng, lat: points[i].lat })),
    );

    const rows = await db.$queryRaw<
      Array<{ i: number; syscol: string | null; numSection: string | null; commune: string | null }>
    >`
      WITH pts AS (
        SELECT (e->>'i')::int AS i,
               ST_SetSRID(ST_MakePoint((e->>'lng')::float8, (e->>'lat')::float8), 4326) AS geom
        FROM json_array_elements(${payload}::json) AS e
      )
      SELECT pts.i AS i, near."syscolCommune" AS syscol, near."numSection" AS "numSection", near."commune" AS commune
      FROM pts
      LEFT JOIN LATERAL (
        SELECT s."syscolCommune", s."numSection", s."commune"
        FROM "limite_section" s
        WHERE s.geom IS NOT NULL
          AND ST_DWithin(s.geom::geography, pts.geom::geography, 50)
        ORDER BY s.geom <-> pts.geom
        LIMIT 1
      ) near ON true
    `;

    for (const r of rows) {
      const i = Number(r.i);
      if (r.syscol) result[i] = { syscolCommune: r.syscol, numSection: r.numSection, commune: r.commune, approx: true };
    }
  }

  return result;
}
```

**Piège à vérifier en écrivant** : `data.ts`'s passe 2 (repli de proximité)
utilise `ORDER BY ... <->` (index de distance) pour prendre le plus proche —
lire la version EXACTE de `getSyscols2026ForPoints`'s passe 2 dans
`data.ts` (pas seulement la passe 1, déjà montrée dans le brief) avant
d'écrire celle-ci, pour confirmer que le `LIMIT 1`/`ORDER BY` de la passe 2
ci-dessus correspond exactement au pattern déjà en place (opérateur de tri
par distance, présence ou non d'un `ORDER BY` explicite) — ne pas deviner.

- [ ] **Step 3: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/lib/cadastre/sections-data.ts
git add src/lib/cadastre/sections-data.ts
git commit -m "feat(cadastre): add getSectionsForPoints spatial join against limite_section"
```

---

### Task 2: `assignSectionNicad` — construction du NICAD par jointure sections

**Files:**
- Create: `src/lib/cadastre/assign-section-nicad.ts`

**Interfaces:**
- Consumes: `getSectionsForPoints` (Task 1, `@/lib/cadastre/sections-data`); `extractNicad` (`@/lib/geo-engine`, existant); `validateNicadFormat` (`@/lib/cadastre/nicad-logic`, existant); `buildNicad` (`@/lib/nicad`, existant); `normalizeNumeroParcelle` (`@/lib/nicad`, existant).
- Produces: `assignSectionNicad(features: GeoJSON.Feature[]): Promise<{ nbConstruits: number; nbSansSection: number; nbSansNumeroParcelle: number; warnings: string[] }>` (mute `features` en place — ajoute/corrige la propriété `nicad` des features concernées).

- [ ] **Step 1: Lire les fonctions réutilisées**

Lire en entier : `extractNicad` (`src/lib/geo-engine.ts`, ~ligne 132),
`validateNicadFormat` (`src/lib/cadastre/nicad-logic.ts`, ~ligne 72),
`buildNicad` (`src/lib/nicad.ts`, ~ligne 92 — signature
`(prefix8: string, section3: string | null, parcelle5: string | null): string | null`,
renvoie `null` si `parcelle5` est `null`), `normalizeNumeroParcelle`
(`src/lib/nicad.ts`, ~ligne 38 — renvoie `{ value: string | null; status:
"ok" | "padded" | "truncated" | "none" }`). Noter les alias de numéro de
parcelle déjà définis dans `PARCELLE_TARGET_FIELDS` (`src/lib/import/field-
mapping.ts` — `numparcell`, `num_parce`, `numparce`, `numparcelle`).

- [ ] **Step 2: Écrire `src/lib/cadastre/assign-section-nicad.ts`**

```ts
/**
 * assign-section-nicad.ts — construction du NICAD des parcelles shapefile
 * (chemin page d'accueil → `Analysis`, `job.kind === "parcelles"`) par
 * jointure spatiale sur `limite_section`, symétrique de
 * `assign-nicad-2026.ts` (jointure commune pour le DXF) mais résolvant
 * Syscol ET section en une seule requête, `limite_section` portant les deux.
 *
 * Ne reconstruit JAMAIS un NICAD déjà valide (16 chiffres, format correct) —
 * ne comble que les trous. N'attribue jamais de numéro de parcelle par
 * incrémentation : si aucun numéro exploitable n'est dans les propriétés
 * `.dbf` de la parcelle, son NICAD reste non construit (cf.
 * `fillMissingNicadForSection`, ailleurs, pour l'attribution après coup).
 */
import * as turf from "@turf/turf";
import { getSectionsForPoints } from "./sections-data";
import { extractNicad } from "@/lib/geo-engine";
import { validateNicadFormat } from "./nicad-logic";
import { buildNicad, normalizeNumeroParcelle } from "@/lib/nicad";

const NUM_PARCELLE_ALIASES = ["numparcell", "num_parce", "numparce", "numparcelle"];

function extractNumParcelle(props: Record<string, unknown> | undefined | null): string | null {
  if (!props) return null;
  for (const alias of NUM_PARCELLE_ALIASES) {
    const hit = Object.entries(props).find(([k]) => k.toLowerCase() === alias);
    if (hit && hit[1] != null && String(hit[1]).trim()) {
      return normalizeNumeroParcelle(String(hit[1])).value;
    }
  }
  return null;
}

function representativePoint(geometry: GeoJSON.Feature["geometry"]): [number, number] | null {
  if (!geometry) return null;
  try {
    return turf.pointOnFeature(turf.feature(geometry)).geometry.coordinates as [number, number];
  } catch {
    return null;
  }
}

export async function assignSectionNicad(
  features: GeoJSON.Feature[],
): Promise<{ nbConstruits: number; nbSansSection: number; nbSansNumeroParcelle: number; warnings: string[] }> {
  let nbConstruits = 0;
  let nbSansSection = 0;
  let nbSansNumeroParcelle = 0;
  const warnings: string[] = [];

  // Ne traite que les parcelles sans NICAD déjà valide.
  const candidates: { index: number; point: [number, number] }[] = [];
  for (let i = 0; i < features.length; i++) {
    const props = (features[i].properties ?? {}) as Record<string, unknown>;
    const existing = extractNicad(props);
    if (existing && validateNicadFormat(existing).valid) continue;

    const point = representativePoint(features[i].geometry);
    if (!point) continue;
    candidates.push({ index: i, point });
  }

  if (candidates.length === 0) {
    return { nbConstruits, nbSansSection, nbSansNumeroParcelle, warnings };
  }

  const matches = await getSectionsForPoints(candidates.map((c) => ({ lng: c.point[0], lat: c.point[1] })));

  let nbApprox = 0;
  candidates.forEach((c, k) => {
    const m = matches[k];
    if (!m.syscolCommune) {
      nbSansSection++;
      return;
    }
    if (m.approx) nbApprox++;

    const props = (features[c.index].properties ?? {}) as Record<string, unknown>;
    const numParcelle = extractNumParcelle(props);
    if (!numParcelle) {
      nbSansNumeroParcelle++;
      return;
    }

    const nicad = buildNicad(m.syscolCommune, m.numSection, numParcelle);
    if (nicad) {
      features[c.index].properties = { ...props, nicad };
      nbConstruits++;
    }
  });

  if (nbApprox > 0) {
    warnings.push(
      `${nbApprox} parcelle(s) rattachée(s) à une section par proximité ` +
        "(point hors contenance stricte, ≤ 50 m d'une limite) — NICAD à vérifier.",
    );
  }
  if (nbSansSection > 0) {
    warnings.push(
      `${nbSansSection} parcelle(s) sans section correspondante dans limite_section ` +
        "(hors emprise du référentiel) — NICAD non construit.",
    );
  }
  if (nbSansNumeroParcelle > 0) {
    warnings.push(
      `${nbSansNumeroParcelle} parcelle(s) rattachée(s) à une section mais sans numéro de ` +
        "parcelle exploitable dans le fichier source — NICAD non construit.",
    );
  }

  return { nbConstruits, nbSansSection, nbSansNumeroParcelle, warnings };
}
```

**Point d'attention à l'implémentation** : `extractNumParcelle` ci-dessus
compare les clés en minuscules (`k.toLowerCase() === alias`) pour tolérer la
casse réelle des colonnes `.dbf` (souvent en majuscules) — vérifier que
c'est cohérent avec la façon dont `extractNicad`/les autres extracteurs de
ce projet gèrent la casse (`extractNicad` liste des variantes de casse
explicites : `props.nicad ?? props.NICAD ?? props.Nicad ?? ...` — CHOISIR
UNE SEULE approche cohérente, ne pas mélanger les deux styles dans le même
fichier ; si le style « variantes explicites » est plus simple à maintenir
ici vu le nombre réduit d'alias, l'utiliser à la place de la comparaison
`toLowerCase()`).

- [ ] **Step 3: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/lib/cadastre/assign-section-nicad.ts
git add src/lib/cadastre/assign-section-nicad.ts
git commit -m "feat(cadastre): add assignSectionNicad (fills missing NICAD via section spatial join)"
```

---

### Task 3: Brancher dans `run-shapefile-job.ts`

**Files:**
- Modify: `src/lib/import/run-shapefile-job.ts`

**Interfaces:**
- Consumes: `assignSectionNicad` (Task 2, `@/lib/cadastre/assign-section-nicad`).

- [ ] **Step 1: Lire la branche `job.kind === "parcelles"` actuelle**

Cette branche (ajoutée par le plan précédent) ressemble à :
```ts
    if (job.kind === "parcelles") {
      const source = await shapefile.read(shpBuf, dbfBuf);
      let features = (source.features ?? []) as GeoJSON.Feature[];

      const prjText = prjBuf?.toString("utf8");
      if (prjText && prjText.includes("UTM") && prjText.includes("28")) {
        features = reprojectFeaturesToWgs84(features) as GeoJSON.Feature[];
      } else {
        features = features.map((f) => ({
          ...f,
          geometry: convertGeometryToWgs84(f.geometry) as typeof f.geometry,
        }));
      }

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "read", 20);
      await finishParcellesJob(jobId, { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType }, features);
      return;
    }
```
(Cette lecture sert à confirmer le contenu réel — le code a pu légèrement
dériver depuis la rédaction de ce plan ; se fier au contenu du fichier, pas
au numéro de ligne.)

**Important — la reprojection (bloc ci-dessus) DOIT s'exécuter AVANT
`assignSectionNicad`** : la jointure spatiale sur `limite_section` compare
des géométries en EPSG:4326 (WGS84), donc les coordonnées doivent déjà être
reprojetées avant de calculer le point représentatif de chaque parcelle —
sinon la jointure comparerait des coordonnées UTM à des polygones WGS84 et
ne trouverait jamais de section.

- [ ] **Step 2: Insérer l'appel à `assignSectionNicad`**

Juste après le bloc de reprojection (if/else `reprojectFeaturesToWgs84` /
`convertGeometryToWgs84`) et avant `await assertNotCancelled(jobId); await
setJobPhase(jobId, "read", 20);`, insérer :

```ts
      await assertNotCancelled(jobId);
      const sectionNicad = await assignSectionNicad(features);
```

Puis modifier l'appel à `finishParcellesJob` pour transmettre les
avertissements de cette étape dans le rapport final, en réutilisant le
paramètre `extra` déjà supporté par `finishParcellesJob` (Task 2 du plan
précédent) :

```ts
      await setJobPhase(jobId, "read", 20);
      await finishParcellesJob(
        jobId,
        { fileName: job.fileName, userId: job.userId, sourceType: job.sourceType as SourceType },
        features,
        sectionNicad.warnings.length > 0 ? { reportExtra: { warnings: sectionNicad.warnings } } : undefined,
      );
      return;
```

**Vérifier avant d'écrire** : `finishParcellesJob`'s final `report` object
(`src/lib/import/run-job.ts`) est `{ ...extra.reportExtra, totalFeatures,
errorCount, conformityScore, outOfSenegalCount }` — confirmer que fusionner
`{ warnings: [...] }` dans `reportExtra` ne rentre pas en conflit avec une
clé `warnings` déjà posée ailleurs dans ce même objet pour ce chemin (a
priori non, la branche `"parcelles"` n'en pose pas d'autre) ; confirmer
aussi que le client (`HomeClient.tsx`'s `pollImportJob`) lit bien
`job.report?.warnings` pour les afficher (déjà le cas — vérifié dans le
plan précédent, `warnings.length` déclenche un `toast.warning`).

- [ ] **Step 3: Import**

Ajouter, avec les autres imports de ce fichier :
```ts
import { assignSectionNicad } from "@/lib/cadastre/assign-section-nicad";
```

- [ ] **Step 4: Lint + typecheck + commit**

```bash
npx tsc --noEmit -p .
npx eslint src/lib/import/run-shapefile-job.ts
git add src/lib/import/run-shapefile-job.ts
git commit -m "feat(import): fill missing NICAD via section spatial join in the home-page shapefile job"
```

- [ ] **Step 5: Vérification manuelle (à documenter comme sautée si pas de serveur)**

`bun run dev`, page d'accueil, importer un `.shp` de parcelles dont le
`.dbf` porte un numéro de parcelle mais pas de NICAD exploitable, sur une
zone déjà couverte par des sections dans `/cadastre/sections` : confirmer
que le NICAD final (visible dans la table attributaire de `/map`) porte le
bon Syscol/section, et que les avertissements (section non trouvée / numéro
de parcelle manquant, le cas échéant) apparaissent bien dans le rapport
final.

---

### Task 4: Documentation (`docs/CONCEPTS-TRAITEMENT-DXF.md` + `docs/README.md`)

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md`
- Modify: `docs/README.md`

Per `CLAUDE.md`, documenter dans `docs/CONCEPTS-TRAITEMENT-DXF.md` (vérifier
le numéro de section exact avant d'écrire — la dernière section existante
après le plan précédent est `16`, donc celle-ci devient probablement `17`) :

- **Problème métier** : le chemin shapefile → `Analysis` de la page
  d'accueil ne construisait aucun NICAD — une parcelle sans NICAD
  exploitable dans son `.dbf` restait sans identifiant cadastral, alors que
  sa section (et donc son Syscol) est souvent déjà connue dans
  `limite_section`.
- **Cause technique** : contrairement au DXF (qui résout le Syscol par
  jointure commune, la section étant déjà portée par le dessin), le
  shapefile de ce chemin ne bénéficiait d'aucune résolution — ni commune ni
  section.
- **Solution** (fichiers·fonctions) : `getSectionsForPoints`
  (`src/lib/cadastre/sections-data.ts`, jointure spatiale batch sur
  `limite_section`, même pattern à deux passes que `getSyscols2026ForPoints`),
  `assignSectionNicad` (`src/lib/cadastre/assign-section-nicad.ts`, ne
  comble que les NICAD manquants/invalides, construit via `buildNicad` avec
  le numéro de parcelle déjà présent dans le `.dbf`), branchée dans
  `run-shapefile-job.ts` juste avant `finishParcellesJob`.
- **Pourquoi** : `limite_section` porte à la fois Syscol ET numéro de
  section (contrairement à `cad_communes_2026`, commune seule) — une seule
  jointure suffit à construire un NICAD complet. Piège : ne jamais écraser
  un NICAD déjà valide (peut provenir d'un traitement antérieur plus
  fiable que la jointure géométrique) ; ne jamais attribuer un numéro de
  parcelle par incrémentation à cette étape (réservé à l'outil dédié
  `fillMissingNicadForSection`, qui opère après coup et avec une décision
  utilisateur explicite, pas silencieusement à l'import).

Ajouter la référence correspondante dans `docs/README.md`, même convention
que les entrées précédentes.

- [ ] **Step 1: Commit**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md docs/README.md
git commit -m "docs(cadastre): document section-join NICAD construction for the home-page shapefile path"
```

---

## Self-Review Notes

- **Aucune duplication de la jointure spatiale existante** : `getSectionsForPoints`
  suit le pattern déjà en place (`getSyscols2026ForPoints`) sans le
  modifier — celui-ci reste dédié aux communes 2026, séparé du nouveau,
  dédié aux sections.
- **Cohérence avec la décision humaine** : le plan applique strictement les
  trois choix validés (uniquement le chemin page d'accueil ; numéro de
  parcelle depuis le `.dbf` seulement, pas d'incrémentation ; NICAD déjà
  valide jamais écrasé) — aucun n'est laissé à l'appréciation de
  l'implémenteur.
- **Ordre critique signalé explicitement** (Task 3, Step 1) : la
  reprojection doit précéder la jointure sections, sans quoi la jointure
  échouerait silencieusement sur des coordonnées encore en UTM.
