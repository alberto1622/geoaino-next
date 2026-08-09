# Historique et restauration — actions restantes (numero, correct, correct-batch, merge, nicad-fill, map-delete, map-rename) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `CadHistoryEntry` history/restore infrastructure (currently wired only for `delete`, cf. `docs/superpowers/plans/2026-08-06-cadastre-history-restore-delete.md`) to the 7 remaining mutating actions listed in the design doc: `numero`, `correct`, `correct-batch`, `merge`, `nicad-fill` on `/cadastre/sections`, and `map-delete`, `map-rename` on `/map`. After this plan, every destructive action in scope of the design doc leaves a restorable trace.

**Architecture:** Same pattern as `delete`: each mutating route captures a full snapshot of the rows/blobs it is about to change, applies its mutation, and calls `recordHistory(tx, ...)` — all inside one Prisma interactive transaction (`prisma.$transaction(async (tx) => ...)`). A `RevertFn` per action, registered in `REVERT_HANDLERS` (`src/lib/cadastre/history.ts`), re-applies the captured `before` snapshot when `POST /api/cadastre/history/[id]/restore` is called. Three of the target routes (`nicad-fill`, `map-delete`, `map-rename`) currently use Prisma's **array-form** `$transaction([...])`, which cannot embed `recordHistory` — this plan converts them to the callback form. Two shared library functions (`overlap-correction.ts::applyOverlapCorrection`, `nicad-fill-missing.ts::fillMissingNicadForSection`) currently hard-code `prisma` instead of accepting a transaction client — this plan threads a `Db`/`tx` parameter through them, following the pattern `sections-data.ts` already established for `delete`.

Two snapshot shapes are reused across multiple actions instead of inventing one per action:
- `SectionsDeleteSnapshot { sections: LimiteSectionRow[]; overlaps: LimiteSectionOverlapRow[] }` (already exists, used by `delete`) is reused as-is for `correct`, `correct-batch`, and `merge` — all three only ever touch `limite_section`/`limite_section_overlap` rows, so the same "full rows before" capture and the same revert logic (reinsert/upsert every captured row) applies unchanged.
- `MapEditSnapshot { correctedGeoJson: string; errorPatches: {errorId, corrected}[] }` is reused for `map-delete` and `map-rename` — both only ever touch one `Analysis.correctedData` blob plus a handful of `TopologicalError.corrected` flags, exactly the shape the existing (client-driven) undo/redo route `/api/analyses/[id]/history/restore` already uses.

`numero` and `nicad-fill` each get their own snapshot shape (`SectionsNumeroSnapshot`, `NicadFillSnapshot`) because their "before" state doesn't fit either of the above.

**Tech Stack:** Next.js App Router API routes, Prisma (PostgreSQL + PostGIS via raw SQL for `limite_section*`), `@turf/turf` for geometry ops. No automated test framework in this project — verification is manual (dev server + UI + `psql`/Prisma Studio), same as the `delete` plan.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md`. This plan follows it for anything not explicitly covered below.
- Every mutating route in scope wraps **capture snapshot → mutate → record history** in a single `prisma.$transaction(async (tx) => …)` — an action must never succeed without leaving a restorable trace. Exception, explicitly inherited from the existing `delete`/`correct` behavior and NOT changed by this plan: `refreshOverlaps(sourceFichier)` (recomputing PENDING overlaps after a geometry change) stays **outside** the transaction, exactly as it already does today — it is a derived recomputation, not part of the tracked mutation.
- Restoring stays gated to the `ADMIN` role (`POST /api/cadastre/history/[id]/restore`, unchanged by this plan). The mutating routes keep whatever role check they already have today: `ADMIN` for all `/cadastre/sections/*` routes, session-only (any authenticated user) for the two `/map` routes — this plan does not change who is allowed to trigger a mutation, only who can restore one.
- History stays append-only: restoring an entry never edits or deletes it (only stamps `restoredAt`/`restoredBy`) and writes a **new** `action: "restore"` entry — unchanged, already implemented by the generic restore route.
- `RevertFn`'s signature gains a third parameter, `scopeKey: string | null` (Task 2), because `map-delete`/`map-rename` reverts need to know *which* `Analysis.id` to write back to, and that id lives in `CadHistoryEntry.scopeKey`, not inside the snapshot itself. Every existing and new revert function keeps accepting `(tx, before)` and simply doesn't use the third argument unless it needs it (only `revertMap` does) — no other revert function's body changes shape.
- `correct-batch` intentionally does **not** get a single aggregate history entry for the whole batch. Its existing, documented behavior is "continue even if one item fails, no batch-wide rollback" (`correct-batch/route.ts` lines 26-28) — wrapping the *entire* loop in one transaction would silently change that into all-or-nothing. Instead, each successfully-corrected overlap gets its **own** small transaction (capture + mutate + one history entry), reusing the exact same helper as the single-overlap `correct` route. This means a batch of 50 overlap fixes produces up to 50 independently restorable history entries, tagged `action: "correct-batch"` to distinguish their origin from single-overlap `action: "correct"` entries in the audit trail — both share the same revert handler.
- This project has no automated test framework (no `*.test.ts`, no `test` script in `package.json`). Do not add one — out of scope. Verification is manual: dev server + UI + `psql`/Prisma Studio inspection, plus `npx tsc --noEmit` and `npx eslint .` after each task.
- Known, accepted limitation for `numero`: reverting a numéro change restores `limite_section.numSection` only. If the numéro change triggered `syncNicadForSectionChange` (rewriting NICAD on parcels in `Analysis.correctedData`), that downstream NICAD rewrite is **not** automatically reverted — attempting to reverse it would require re-running the sync algorithm backward, which is disproportionate to this plan's scope and is not requested. This is documented inline in the route and in `docs/CONCEPTS-TRAITEMENT-DXF.md` (Task 2, Step 4).

---

### Task 1: Shared `sections-data.ts` / infra changes needed by every remaining `sections` action

**Files:**
- Modify: `src/lib/cadastre/sections-data.ts`

**Interfaces:**
- Modifies existing signatures (backward compatible — every new parameter has a default, every existing call site keeps working unchanged): `getSection(id, db?)`, `getSectionsByIds(ids, db?)`, `updateSectionGeometry(id, geomGeoJson, surfaceM2, db?)`, `getOverlap(id, db?)`, `setOverlapStatus(id, status, db?)`, `findSectionNumeroConflict(syscolCommune, numSection, excludeId, db?)`, `updateSectionNumero(id, numSection, db?)` (also widens `numSection` to `string | null`, needed so a revert can restore an unnumbered section).
- Produces (new exports): `getSectionsFullByIds(ids: number[], db?: Db): Promise<LimiteSectionRow[]>` (order-preserving, like `getSectionsByIds`), `getOverlapsForSections(ids: number[], db?: Db): Promise<LimiteSectionOverlapRow[]>`, `getOverlapFull(id: number, db?: Db): Promise<LimiteSectionOverlapRow | null>`.
- Changes reinsert semantics: `reinsertLimiteSections` and `reinsertLimiteSectionOverlaps` switch from `ON CONFLICT (id) DO NOTHING` to `ON CONFLICT (id) DO UPDATE SET ...`. Needed because `correct`'s "ignore" revert and `merge`'s "kept section" revert both target a row that **still exists** at revert time (only some of its columns changed) — `DO NOTHING` would silently skip restoring it. This is a strict generalization: for `delete`'s existing use case (the row was fully removed), `DO UPDATE` behaves identically to a plain `INSERT` since there is nothing to conflict with; replaying a restore twice is still a no-op the second time (same values written twice).

- [ ] **Step 1: Widen `getSection` to accept a transaction client**

Replace:

```ts
/** GeoJSON + lot d'une section (pour appliquer une correction géométrique ou attribuer un numéro). */
export async function getSection(
  id: number,
): Promise<{
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  sourceFichier: string;
  numSection: string | null;
  syscolCommune: string | null;
  commune: string | null;
} | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
      sourceFichier: string;
      numSection: string | null;
      syscolCommune: string | null;
      commune: string | null;
    }>
  >`
    SELECT "geomGeoJson", "sourceFichier", "numSection", "syscolCommune", "commune"
    FROM "limite_section" WHERE id = ${id}
  `;
  return rows[0] ?? null;
}
```

with:

```ts
/** GeoJSON + lot d'une section (pour appliquer une correction géométrique ou attribuer un numéro). */
export async function getSection(
  id: number,
  db: Db = prisma,
): Promise<{
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  sourceFichier: string;
  numSection: string | null;
  syscolCommune: string | null;
  commune: string | null;
} | null> {
  const rows = await db.$queryRaw<
    Array<{
      geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
      sourceFichier: string;
      numSection: string | null;
      syscolCommune: string | null;
      commune: string | null;
    }>
  >`
    SELECT "geomGeoJson", "sourceFichier", "numSection", "syscolCommune", "commune"
    FROM "limite_section" WHERE id = ${id}
  `;
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Widen `getSectionsByIds` and add batch full-row variant `getSectionsFullByIds`**

Replace:

```ts
/** Sections par ids (fusion manuelle) — renvoyées dans l'ordre demandé. */
export async function getSectionsByIds(
  ids: number[],
): Promise<Array<{ id: number; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>> {
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<
    Array<{ id: number | bigint; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>
  >`
    SELECT id, "geomGeoJson", "sourceFichier", "numSection"
    FROM "limite_section" WHERE id IN (${Prisma.join(ids)})
  `;
  const byId = new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r != null);
}
```

with:

```ts
/** Sections par ids (fusion manuelle) — renvoyées dans l'ordre demandé. */
export async function getSectionsByIds(
  ids: number[],
  db: Db = prisma,
): Promise<Array<{ id: number; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<
    Array<{ id: number | bigint; geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>
  >`
    SELECT id, "geomGeoJson", "sourceFichier", "numSection"
    FROM "limite_section" WHERE id IN (${Prisma.join(ids)})
  `;
  const byId = new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id) }]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r != null);
}

/** Lignes `limite_section` complètes par ids (fusion manuelle) — snapshot avant
 * fusion, ordre préservé selon `ids` comme `getSectionsByIds`, à la différence
 * que toutes les colonnes sont renvoyées (nécessaire pour restaurer). */
export async function getSectionsFullByIds(ids: number[], db: Db = prisma): Promise<LimiteSectionRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<RawSectionRow[]>`
    SELECT id, "region", "departement", "commune", "syscolCommune", "numSection",
           "surfaceM2", "geomGeoJson", "sourceFichier", "createdAt", "updatedAt"
    FROM "limite_section" WHERE id IN (${Prisma.join(ids)})
  `;
  const byId = new Map(rows.map((r) => [r.id, normalizeSectionRow(r)]));
  return ids.map((id) => byId.get(id)).filter((r): r is LimiteSectionRow => r != null);
}

/** Chevauchements complets référençant au moins une des sections données —
 * snapshot avant fusion/correction touchant plusieurs sections à la fois. */
export async function getOverlapsForSections(ids: number[], db: Db = prisma): Promise<LimiteSectionOverlapRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<RawOverlapRow[]>`
    SELECT id, "sourceFichier", "sectionAId", "sectionBId", "intersectionGeoJson",
           "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_overlap"
    WHERE "sectionAId" IN (${Prisma.join(ids)}) OR "sectionBId" IN (${Prisma.join(ids)})
  `;
  return rows.map(normalizeOverlapRow);
}
```

- [ ] **Step 3: Add `getOverlapFull`**

Right after `getOverlapsFullBySource` (ends around line 149), insert:

```ts
/** Chevauchement complet (toutes colonnes) par id — snapshot pour l'historique
 * de correction, à la différence de `getOverlap` qui ne renvoie que les
 * champs utiles à la résolution. */
export async function getOverlapFull(id: number, db: Db = prisma): Promise<LimiteSectionOverlapRow | null> {
  const rows = await db.$queryRaw<RawOverlapRow[]>`
    SELECT id, "sourceFichier", "sectionAId", "sectionBId", "intersectionGeoJson",
           "overlapAreaM2", "status", "createdAt"
    FROM "limite_section_overlap" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? normalizeOverlapRow(r) : null;
}
```

- [ ] **Step 4: Switch `reinsertLimiteSections` to upsert**

Replace:

```ts
/** Réinsère des lignes `limite_section` avec leur id d'origine (restauration
 * d'historique). `ON CONFLICT DO NOTHING` : une restauration rejouée deux fois
 * ne doit pas échouer, juste ne rien changer la seconde fois. */
export async function reinsertLimiteSections(rows: LimiteSectionRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    const geojson = JSON.stringify(r.geomGeoJson);
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section"
        (id, "region","departement","commune","syscolCommune","numSection","surfaceM2",
         "geomGeoJson","geom","sourceFichier","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,${GEOM_FROM_GEOJSON("$8")},$9,$10,$11)
      ON CONFLICT (id) DO NOTHING
      `,
      r.id, r.region, r.departement, r.commune, r.syscolCommune, r.numSection, r.surfaceM2,
      geojson, r.sourceFichier, new Date(r.createdAt), new Date(r.updatedAt),
    );
  }
}
```

with:

```ts
/** Réinsère (ou remet à jour) des lignes `limite_section` avec leur id
 * d'origine (restauration d'historique). `ON CONFLICT DO UPDATE` : la ligne
 * peut avoir été supprimée entre-temps (revert de `delete`) OU exister encore
 * avec des colonnes différentes (revert de `correct`/`merge`, où la section
 * cible a été modifiée mais pas supprimée) — dans les deux cas, le résultat
 * voulu est "cette ligne redevient exactement le snapshot". Idempotent : une
 * restauration rejouée deux fois réécrit deux fois les mêmes valeurs. */
export async function reinsertLimiteSections(rows: LimiteSectionRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    const geojson = JSON.stringify(r.geomGeoJson);
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section"
        (id, "region","departement","commune","syscolCommune","numSection","surfaceM2",
         "geomGeoJson","geom","sourceFichier","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,${GEOM_FROM_GEOJSON("$8")},$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        "region" = EXCLUDED."region",
        "departement" = EXCLUDED."departement",
        "commune" = EXCLUDED."commune",
        "syscolCommune" = EXCLUDED."syscolCommune",
        "numSection" = EXCLUDED."numSection",
        "surfaceM2" = EXCLUDED."surfaceM2",
        "geomGeoJson" = EXCLUDED."geomGeoJson",
        "geom" = EXCLUDED."geom",
        "sourceFichier" = EXCLUDED."sourceFichier",
        "updatedAt" = EXCLUDED."updatedAt"
      `,
      r.id, r.region, r.departement, r.commune, r.syscolCommune, r.numSection, r.surfaceM2,
      geojson, r.sourceFichier, new Date(r.createdAt), new Date(r.updatedAt),
    );
  }
}
```

- [ ] **Step 5: Switch `reinsertLimiteSectionOverlaps` to upsert**

Replace:

```ts
/** Réinsère des lignes `limite_section_overlap` avec leur id d'origine. */
export async function reinsertLimiteSectionOverlaps(rows: LimiteSectionOverlapRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section_overlap"
        (id, "sourceFichier","sectionAId","sectionBId","intersectionGeoJson","overlapAreaM2","status","createdAt")
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING
      `,
      r.id, r.sourceFichier, r.sectionAId, r.sectionBId, JSON.stringify(r.intersectionGeoJson), r.overlapAreaM2, r.status, new Date(r.createdAt),
    );
  }
}
```

with:

```ts
/** Réinsère (ou remet à jour) des lignes `limite_section_overlap` avec leur id
 * d'origine — même raisonnement upsert que `reinsertLimiteSections` : le
 * revert d'une action `ignore` cible un overlap dont seul le `status` a
 * changé, la ligne existe toujours. */
export async function reinsertLimiteSectionOverlaps(rows: LimiteSectionOverlapRow[], db: Db = prisma): Promise<void> {
  for (const r of rows) {
    await db.$executeRawUnsafe(
      `
      INSERT INTO "limite_section_overlap"
        (id, "sourceFichier","sectionAId","sectionBId","intersectionGeoJson","overlapAreaM2","status","createdAt")
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        "sourceFichier" = EXCLUDED."sourceFichier",
        "sectionAId" = EXCLUDED."sectionAId",
        "sectionBId" = EXCLUDED."sectionBId",
        "intersectionGeoJson" = EXCLUDED."intersectionGeoJson",
        "overlapAreaM2" = EXCLUDED."overlapAreaM2",
        "status" = EXCLUDED."status"
      `,
      r.id, r.sourceFichier, r.sectionAId, r.sectionBId, JSON.stringify(r.intersectionGeoJson), r.overlapAreaM2, r.status, new Date(r.createdAt),
    );
  }
}
```

- [ ] **Step 6: Widen `updateSectionGeometry`**

Replace:

```ts
/** Met à jour la géométrie (GeoJSON + geom PostGIS) et la surface d'une section. */
export async function updateSectionGeometry(
  id: number,
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  surfaceM2: number,
): Promise<void> {
  const geojson = JSON.stringify(geomGeoJson);
  await prisma.$executeRawUnsafe(
    `
    UPDATE "limite_section"
    SET "geomGeoJson" = $2::jsonb,
        "geom" = ${GEOM_FROM_GEOJSON("$2")},
        "surfaceM2" = $3,
        "updatedAt" = now()
    WHERE id = $1
    `,
    id,
    geojson,
    surfaceM2,
  );
}
```

with:

```ts
/** Met à jour la géométrie (GeoJSON + geom PostGIS) et la surface d'une section. */
export async function updateSectionGeometry(
  id: number,
  geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  surfaceM2: number,
  db: Db = prisma,
): Promise<void> {
  const geojson = JSON.stringify(geomGeoJson);
  await db.$executeRawUnsafe(
    `
    UPDATE "limite_section"
    SET "geomGeoJson" = $2::jsonb,
        "geom" = ${GEOM_FROM_GEOJSON("$2")},
        "surfaceM2" = $3,
        "updatedAt" = now()
    WHERE id = $1
    `,
    id,
    geojson,
    surfaceM2,
  );
}
```

- [ ] **Step 7: Widen `findSectionNumeroConflict`**

Replace:

```ts
export async function findSectionNumeroConflict(
  syscolCommune: string | null,
  numSection: string,
  excludeId: number,
): Promise<{ id: number; commune: string | null } | null> {
  if (!syscolCommune) return null;
  const rows = await prisma.$queryRaw<Array<{ id: number | bigint; commune: string | null }>>`
    SELECT id, "commune" FROM "limite_section"
    WHERE "syscolCommune" = ${syscolCommune} AND "numSection" = ${numSection} AND id <> ${excludeId}
    LIMIT 1
  `;
  const r = rows[0];
  return r ? { id: Number(r.id), commune: r.commune } : null;
}
```

with:

```ts
export async function findSectionNumeroConflict(
  syscolCommune: string | null,
  numSection: string,
  excludeId: number,
  db: Db = prisma,
): Promise<{ id: number; commune: string | null } | null> {
  if (!syscolCommune) return null;
  const rows = await db.$queryRaw<Array<{ id: number | bigint; commune: string | null }>>`
    SELECT id, "commune" FROM "limite_section"
    WHERE "syscolCommune" = ${syscolCommune} AND "numSection" = ${numSection} AND id <> ${excludeId}
    LIMIT 1
  `;
  const r = rows[0];
  return r ? { id: Number(r.id), commune: r.commune } : null;
}
```

- [ ] **Step 8: Widen `updateSectionNumero` (also allow `null`, needed to revert to an unnumbered section)**

Replace:

```ts
/** Attribue un numéro à une section (n'affecte pas la géométrie ni les chevauchements). */
export async function updateSectionNumero(id: number, numSection: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "limite_section" SET "numSection" = ${numSection}, "updatedAt" = now() WHERE id = ${id}
  `;
}
```

with:

```ts
/** Attribue un numéro à une section (n'affecte pas la géométrie ni les
 * chevauchements). `numSection: null` remet la section à l'état "sans
 * numéro" — utilisé par le revert d'une action `numero`. */
export async function updateSectionNumero(id: number, numSection: string | null, db: Db = prisma): Promise<void> {
  await db.$executeRaw`
    UPDATE "limite_section" SET "numSection" = ${numSection}, "updatedAt" = now() WHERE id = ${id}
  `;
}
```

- [ ] **Step 9: Widen `getOverlap` and `setOverlapStatus`**

Replace:

```ts
/** Chevauchement seul (résolution d'une correction). */
export async function getOverlap(
  id: number,
): Promise<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string }>
  >`
    SELECT id, "sectionAId", "sectionBId", "sourceFichier", "status"
    FROM "limite_section_overlap" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? { ...r, id: Number(r.id), sectionAId: Number(r.sectionAId), sectionBId: Number(r.sectionBId) } : null;
}

/** Change le statut d'un chevauchement (ex. IGNORED). */
export async function setOverlapStatus(id: number, status: "PENDING" | "RESOLVED" | "IGNORED"): Promise<void> {
  await prisma.$executeRaw`UPDATE "limite_section_overlap" SET "status" = ${status} WHERE id = ${id}`;
}
```

with:

```ts
/** Chevauchement seul (résolution d'une correction). */
export async function getOverlap(
  id: number,
  db: Db = prisma,
): Promise<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string } | null> {
  const rows = await db.$queryRaw<
    Array<{ id: number; sectionAId: number; sectionBId: number; sourceFichier: string; status: string }>
  >`
    SELECT id, "sectionAId", "sectionBId", "sourceFichier", "status"
    FROM "limite_section_overlap" WHERE id = ${id}
  `;
  const r = rows[0];
  return r ? { ...r, id: Number(r.id), sectionAId: Number(r.sectionAId), sectionBId: Number(r.sectionBId) } : null;
}

/** Change le statut d'un chevauchement (ex. IGNORED). */
export async function setOverlapStatus(
  id: number,
  status: "PENDING" | "RESOLVED" | "IGNORED",
  db: Db = prisma,
): Promise<void> {
  await db.$executeRaw`UPDATE "limite_section_overlap" SET "status" = ${status} WHERE id = ${id}`;
}
```

- [ ] **Step 10: Type-check**

Run: `npx tsc --noEmit` — expect no new errors (every changed signature keeps its old call sites valid via default parameters).

- [ ] **Step 11: Commit**

```bash
git add src/lib/cadastre/sections-data.ts
git commit -m "feat(cadastre): thread tx client through remaining sections-data helpers, add batch snapshot getters, upsert-capable reinsert"
```

---

### Task 2: `history.ts` registry upgrade + `numero` action

**Files:**
- Modify: `src/lib/cadastre/history.ts`
- Modify: `src/app/api/cadastre/history/[id]/restore/route.ts`
- Modify: `src/app/api/cadastre/sections/numero/route.ts`

**Interfaces:**
- Changes: `RevertFn` gains a third parameter `scopeKey: string | null` (existing revert functions ignore it — only `revertMap`, added in Task 6, will use it).
- Produces: `interface SectionsNumeroSnapshot { section: LimiteSectionRow }`.

- [ ] **Step 1: Widen `RevertFn` and pass `scopeKey` through in `history.ts`**

In `src/lib/cadastre/history.ts`, replace:

```ts
export type RevertFn = (tx: Prisma.TransactionClient, before: unknown) => Promise<void>;
```

with:

```ts
export type RevertFn = (
  tx: Prisma.TransactionClient,
  before: unknown,
  scopeKey: string | null,
) => Promise<void>;
```

- [ ] **Step 2: Add `SectionsNumeroSnapshot` + `revertNumero`, update the import line**

Replace the import block at the top of `history.ts`:

```ts
import {
  reinsertLimiteSections,
  reinsertLimiteSectionOverlaps,
  type LimiteSectionRow,
  type LimiteSectionOverlapRow,
} from "@/lib/cadastre/sections-data";
```

with:

```ts
import {
  reinsertLimiteSections,
  reinsertLimiteSectionOverlaps,
  updateSectionNumero,
  type LimiteSectionRow,
  type LimiteSectionOverlapRow,
} from "@/lib/cadastre/sections-data";
```

Then, right after `export interface SectionsDeleteSnapshot { ... }`, insert:

```ts
export interface SectionsNumeroSnapshot {
  section: LimiteSectionRow;
}
```

- [ ] **Step 3: Add `revertNumero`, register it**

Right after the existing `revertDelete` function (and before the `REVERT_HANDLERS` comment block), insert:

```ts
/** Restaure UNIQUEMENT `numSection` (et `updatedAt`) — ne rejoue pas une
 * éventuelle resynchronisation NICAD déclenchée par le changement d'origine
 * (`syncNicadForSectionChange`), limitation documentée dans le plan
 * d'implémentation de cette action. */
async function revertNumero(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as SectionsNumeroSnapshot;
  if (!snapshot?.section) {
    throw new Error("Snapshot de numéro invalide — impossible de restaurer.");
  }
  await updateSectionNumero(snapshot.section.id, snapshot.section.numSection, tx);
}
```

Replace:

```ts
// Un handler par action instrumentée — grandit au fil des plans qui
// instrumentent chacune des routes mutantes restantes (numero, correct,
// correct-batch, merge, nicad-fill, map-delete, map-rename). Une action sans
// handler ici ne peut pas encore être restaurée (la route restore répond 400).
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: revertDelete,
};
```

with:

```ts
// Un handler par action instrumentée. Une action sans handler ici ne peut pas
// encore être restaurée (la route restore répond 400).
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
};
```

(`correct`, `correct-batch`, `merge`, `nicad-fill`, `map-delete`, `map-rename` are added to this object by Tasks 3–6, each appending one line — not touching the lines added here.)

- [ ] **Step 4: Pass `scopeKey` at the call site**

In `src/app/api/cadastre/history/[id]/restore/route.ts`, replace:

```ts
  try {
    await prisma.$transaction(async (tx) => {
      await revert(tx, entry.before);
```

with:

```ts
  try {
    await prisma.$transaction(async (tx) => {
      await revert(tx, entry.before, entry.scopeKey);
```

- [ ] **Step 5: Instrument `POST /api/cadastre/sections/numero`**

Replace the entire content of `src/app/api/cadastre/sections/numero/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getSectionFull,
  findSectionNumeroConflict,
  updateSectionNumero,
} from "@/lib/cadastre/sections-data";
import { normalizeSection } from "@/lib/nicad";
import { syncNicadForSectionChange, type NicadSyncResult } from "@/lib/cadastre/nicad-section-sync";
import { recordHistory, type SectionsNumeroSnapshot } from "@/lib/cadastre/history";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/numero — attribue ou modifie le numéro d'une
 * section (numSection NULL : libellé absent ou hors polygone lors de
 * l'extraction ; numSection déjà renseigné : correction manuelle, cf.
 * docs/CONCEPTS-TRAITEMENT-DXF.md §11 ter). Refuse si une AUTRE section de la
 * même commune (syscolCommune) porte déjà ce numéro — le numéro de section
 * n'est unique QUE dans sa commune (cf. build-sections.ts).
 *
 * Capture un snapshot de la section AVANT changement et l'enregistre comme
 * entrée d'historique restaurable, dans la même transaction que l'écriture —
 * cf. docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 * Le revert restaure UNIQUEMENT `numSection` : la resynchronisation NICAD
 * déclenchée ci-dessous (best-effort, hors transaction) n'est pas annulée
 * automatiquement — limitation connue, cf. Global Constraints du plan
 * d'implémentation de cette action.
 *
 * Après écriture, déclenche `syncNicadForSectionChange` pour reconstruire le
 * NICAD des parcelles rattachées (module Map) — best-effort : un échec de
 * synchronisation n'annule pas l'attribution du numéro, déjà actée.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  let body: { sectionId?: number; numSection?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const sectionId = Number(body.sectionId);
  const numSection = normalizeSection(body.numSection);
  if (!Number.isInteger(sectionId) || !numSection) {
    return NextResponse.json({ error: "sectionId et numSection requis (numérique)" }, { status: 400 });
  }

  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const existing = await getSectionFull(sectionId, tx);
        if (!existing) return { kind: "not-found" as const };
        if (existing.numSection === numSection) return { kind: "noop" as const, existing };

        const conflict = await findSectionNumeroConflict(existing.syscolCommune, numSection, sectionId, tx);
        if (conflict) return { kind: "conflict" as const, conflict };

        await updateSectionNumero(sectionId, numSection, tx);
        const before: SectionsNumeroSnapshot = { section: existing };
        await recordHistory(tx, {
          scope: "sections",
          scopeKey: existing.syscolCommune,
          action: "numero",
          summary: `Numéro de la section ${existing.numSection ?? "#" + existing.id} changé en ${numSection}${existing.commune ? ` (${existing.commune})` : ""}`,
          before,
          after: { numSection },
          createdBy,
        });
        return { kind: "ok" as const, existing };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
    }
    if (outcome.kind === "noop") {
      return NextResponse.json({ success: true, sectionId, numSection, nicadSync: null });
    }
    if (outcome.kind === "conflict") {
      return NextResponse.json(
        {
          error: `Le numéro ${numSection} est déjà utilisé par la section #${outcome.conflict.id}${
            outcome.conflict.commune ? ` (${outcome.conflict.commune})` : ""
          } — fusionnez-les si c'est la même section.`,
        },
        { status: 409 },
      );
    }

    let nicadSync: NicadSyncResult | null = null;
    let nicadSyncError: string | null = null;
    try {
      nicadSync = await syncNicadForSectionChange(outcome.existing, numSection);
    } catch (err) {
      console.error("[cadastre/sections/numero] syncNicadForSectionChange", err);
      nicadSyncError = "La mise à jour des NICAD a échoué ; le numéro de section est enregistré.";
    }

    return NextResponse.json({ success: true, sectionId, numSection, nicadSync, nicadSyncError });
  } catch (err) {
    console.error("[cadastre/sections/numero] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit` — expect no new errors.

- [ ] **Step 7: Manual verification**

`npm run dev`, signed in as ADMIN, on `/cadastre/sections`:
1. Assign or change a section's numéro. Confirm the response is unchanged from before (`{success, sectionId, numSection, nicadSync, nicadSyncError}`).
2. In Prisma Studio, check `cad_history_entries` has a new row `action='numero'` whose `before.section.numSection` is the OLD value.
3. `POST /api/cadastre/history/<id>/restore` (devtools fetch, as in the `delete` plan's Task 6). Confirm `numSection` reverts to the old value in the table, and a new `action='restore'` entry appears.
4. Repeat once assigning a numéro to a previously-unnumbered section (`numSection` was `null`) — confirm the restore correctly sets it back to `null` (not an empty string or error).

- [ ] **Step 8: Commit**

```bash
git add src/lib/cadastre/history.ts src/app/api/cadastre/history/[id]/restore/route.ts src/app/api/cadastre/sections/numero/route.ts
git commit -m "feat(cadastre): capture and restore history for the numero action"
```

---

### Task 3: `correct` and `correct-batch` actions

**Files:**
- Modify: `src/lib/cadastre/overlap-correction.ts`
- Modify: `src/lib/cadastre/history.ts`
- Modify: `src/app/api/cadastre/sections/correct/route.ts`
- Modify: `src/app/api/cadastre/sections/correct-batch/route.ts`

**Interfaces:**
- Changes: `applyOverlapCorrection(overlapId, action, db?)` now returns `Promise<{ sourceFichier: string; snapshot: SectionsDeleteSnapshot }>` instead of `Promise<string>` (breaking change, both call sites updated in this task).
- Produces: `applyOverlapCorrectionWithHistory(overlapId, action, createdBy, historyAction?): Promise<string>` (new, wraps capture+mutate+`recordHistory` in one transaction; `historyAction` defaults to `"correct"`, `correct-batch/route.ts` passes `"correct-batch"`).
- Produces (in `history.ts`): `revertSectionsSnapshot` registered for `correct` and `correct-batch`.

- [ ] **Step 1: Rewrite `overlap-correction.ts`**

Replace the entire content of `src/lib/cadastre/overlap-correction.ts` with:

```ts
/**
 * overlap-correction.ts — résolution d'UN chevauchement `limite_section`.
 * Logique partagée entre `correct/route.ts` (un chevauchement) et
 * `correct-batch/route.ts` (plusieurs, séquentiellement).
 *
 * Ne recalcule PAS les chevauchements du lot (`refreshOverlaps`) — à charge
 * de l'appelant, pour que le traitement par lot ne le fasse qu'une seule
 * fois à la fin au lieu d'une fois par chevauchement traité.
 *
 * `applyOverlapCorrection` capture un snapshot complet (sections + overlaps
 * touchés) AVANT mutation et le renvoie à l'appelant : `applyOverlapCorrectionWithHistory`
 * l'utilise pour écrire une entrée `CadHistoryEntry` restaurable dans la même
 * transaction que la mutation — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
import * as turf from "@turf/turf";
import { prisma } from "@/lib/prisma";
import {
  getOverlap,
  getOverlapFull,
  getSectionFull,
  getOverlapsForSection,
  updateSectionGeometry,
  deleteSection,
  setOverlapStatus,
  type Db,
  type LimiteSectionOverlapRow,
} from "@/lib/cadastre/sections-data";
import { recordHistory, type SectionsDeleteSnapshot } from "@/lib/cadastre/history";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type OverlapAction =
  | "clip_a"
  | "clip_b"
  | "auto"
  | "merge"
  | "delete_a"
  | "delete_b"
  | "ignore";

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

function dedupeOverlaps(rows: LimiteSectionOverlapRow[]): LimiteSectionOverlapRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Array.from(byId.values());
}

/**
 * Résout un chevauchement (une action). Actions :
 *  - `clip_a` / `clip_b` : retire l'intersection de la section A (ou B) —
 *    `turf.difference` ; cible entièrement couverte → supprimée ;
 *  - `auto` : compare l'aire de A et de B (`turf.area`), découpe la plus
 *    GRANDE des deux (équivalent à `clip_a` ou `clip_b` selon le cas) — à
 *    aire égale, découpe B (choix arbitraire mais déterministe) ;
 *  - `merge` : fusionne A et B (`turf.union`), B supprimée ;
 *  - `delete_a` / `delete_b` : supprime la section choisie ;
 *  - `ignore` : marque le chevauchement intentionnel (IGNORED).
 * Renvoie le `sourceFichier` traité ET un snapshot des lignes touchées
 * (AVANT mutation), pour permettre à l'appelant d'enregistrer une entrée
 * d'historique restaurable. Lève une `Error` si l'overlap ou une section est
 * introuvable, ou si la fusion échoue.
 */
export async function applyOverlapCorrection(
  overlapId: number,
  action: OverlapAction,
  db: Db = prisma,
): Promise<{ sourceFichier: string; snapshot: SectionsDeleteSnapshot }> {
  const ov = await getOverlap(overlapId, db);
  if (!ov) throw new Error("Chevauchement introuvable");

  if (action === "ignore") {
    const overlapFull = await getOverlapFull(overlapId, db);
    if (!overlapFull) throw new Error("Chevauchement introuvable");
    await setOverlapStatus(overlapId, "IGNORED", db);
    return { sourceFichier: ov.sourceFichier, snapshot: { sections: [], overlaps: [overlapFull] } };
  }

  const [a, b] = await Promise.all([getSectionFull(ov.sectionAId, db), getSectionFull(ov.sectionBId, db)]);
  if (!a || !b) throw new Error("Section introuvable");
  const [overlapFull, overlapsA, overlapsB] = await Promise.all([
    getOverlapFull(overlapId, db),
    getOverlapsForSection(ov.sectionAId, db),
    getOverlapsForSection(ov.sectionBId, db),
  ]);
  if (!overlapFull) throw new Error("Chevauchement introuvable");
  const snapshot: SectionsDeleteSnapshot = {
    sections: [a, b],
    overlaps: dedupeOverlaps([overlapFull, ...overlapsA, ...overlapsB]),
  };

  const fa = turf.feature(a.geomGeoJson);
  const fb = turf.feature(b.geomGeoJson);

  if (action === "clip_a" || action === "clip_b" || action === "auto") {
    const resolved: "clip_a" | "clip_b" =
      action === "auto"
        ? areaM2(a.geomGeoJson) > areaM2(b.geomGeoJson)
          ? "clip_a"
          : "clip_b"
        : action;
    const targetId = resolved === "clip_a" ? ov.sectionAId : ov.sectionBId;
    const [tf, other] = resolved === "clip_a" ? [fa, fb] : [fb, fa];
    const diff = turf.difference(turf.featureCollection([tf, other]));
    if (!diff || !diff.geometry) {
      await deleteSection(targetId, db); // cible entièrement couverte
    } else {
      const g = diff.geometry as PolyGeom;
      await updateSectionGeometry(targetId, g, areaM2(g), db);
    }
  } else if (action === "merge") {
    const u = turf.union(turf.featureCollection([fa, fb]));
    if (!u || !u.geometry) throw new Error("Fusion impossible");
    const g = u.geometry as PolyGeom;
    await updateSectionGeometry(ov.sectionAId, g, areaM2(g), db);
    await deleteSection(ov.sectionBId, db);
  } else if (action === "delete_a") {
    await deleteSection(ov.sectionAId, db);
  } else if (action === "delete_b") {
    await deleteSection(ov.sectionBId, db);
  }

  return { sourceFichier: ov.sourceFichier, snapshot };
}

/**
 * Applique UNE correction de chevauchement ET enregistre l'entrée
 * d'historique correspondante, dans la même transaction — capture + mutation
 * + historique atomiques (cf. history.ts). Partagé par `correct/route.ts`
 * (une entrée par appel, `historyAction: "correct"`) et
 * `correct-batch/route.ts` (une entrée par item traité avec succès,
 * `historyAction: "correct-batch"` — chaque item du lot reste
 * indépendamment restaurable, cf. Global Constraints du plan
 * d'implémentation de cette action pour le choix de ne PAS agréger le lot en
 * une seule entrée).
 */
export async function applyOverlapCorrectionWithHistory(
  overlapId: number,
  action: OverlapAction,
  createdBy: string | null,
  historyAction: "correct" | "correct-batch" = "correct",
): Promise<string> {
  return prisma.$transaction(
    async (tx) => {
      const { sourceFichier, snapshot } = await applyOverlapCorrection(overlapId, action, tx);
      const first = snapshot.sections[0];
      await recordHistory(tx, {
        scope: "sections",
        scopeKey: first?.syscolCommune ?? null,
        action: historyAction,
        summary:
          first != null
            ? `Correction du chevauchement #${overlapId} (${action}) — ${first.numSection ?? "#" + first.id}${first.commune ? ` (${first.commune})` : ""}`
            : `Chevauchement #${overlapId} ignoré`,
        before: snapshot,
        after: {},
        createdBy,
      });
      return sourceFichier;
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

/** Statut HTTP pour un message d'erreur levé par `applyOverlapCorrection` — reproduit les codes que `correct/route.ts` renvoyait avant l'extraction. */
export function statusForOverlapError(message: string): number {
  if (message === "Chevauchement introuvable" || message === "Section introuvable") return 404;
  if (message === "Fusion impossible") return 400;
  return 500;
}
```

- [ ] **Step 2: Add `revertSectionsSnapshot` to `history.ts`, register it for `correct` and `correct-batch`**

Right after `revertNumero` (added in Task 2), insert:

```ts
/** Revert partagé par `correct`, `correct-batch` et `merge` — les trois
 * n'écrivent jamais que des lignes `limite_section`/`limite_section_overlap`
 * complètes dans `before` (même forme que `SectionsDeleteSnapshot`), donc le
 * même "réinsère/upsère tout ce qui est capturé" suffit dans les trois cas.
 * Contrairement à `revertDelete`, jamais de garde anti-duplication de lot :
 * ces trois actions ne suppriment jamais un `sourceFichier` entier. */
async function revertSectionsSnapshot(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as SectionsDeleteSnapshot;
  if (!Array.isArray(snapshot?.sections) || !Array.isArray(snapshot?.overlaps)) {
    throw new Error("Snapshot invalide — impossible de restaurer.");
  }
  await reinsertLimiteSections(snapshot.sections, tx);
  await reinsertLimiteSectionOverlaps(snapshot.overlaps, tx);
}
```

Then update `REVERT_HANDLERS` (from Task 2's version):

```ts
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
  correct: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-batch": (tx, before) => revertSectionsSnapshot(tx, before),
};
```

- [ ] **Step 3: Update `correct/route.ts`**

Replace the entire content of `src/app/api/cadastre/sections/correct/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  applyOverlapCorrectionWithHistory,
  statusForOverlapError,
  type OverlapAction,
} from "@/lib/cadastre/overlap-correction";
import { refreshOverlaps, listSections, listOverlaps } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

// "auto" est réservé au traitement par lot (`correct-batch` — n'a de sens
// que comparé à un groupe de chevauchements) : cette route à chevauchement
// unique garde EXACTEMENT le même ensemble d'actions qu'avant l'extraction
// (aucun changement d'interface HTTP), donc ne l'inclut pas.
const SINGLE_CORRECT_ACTIONS = new Set<OverlapAction>([
  "clip_a",
  "clip_b",
  "merge",
  "delete_a",
  "delete_b",
  "ignore",
]);

/**
 * POST /api/cadastre/sections/correct — résout un chevauchement entre deux
 * sections (une seule paire). Voir `applyOverlapCorrection` pour le détail
 * des actions. Capture + mutation + historique atomiques (cf.
 * `applyOverlapCorrectionWithHistory`). Renvoie les sections + chevauchements
 * à jour du lot concerné.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  let body: { overlapId?: number; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const overlapId = Number(body.overlapId);
  const action = body.action as OverlapAction;
  if (!Number.isInteger(overlapId) || !SINGLE_CORRECT_ACTIONS.has(action)) {
    return NextResponse.json({ error: "overlapId et action valides requis" }, { status: 400 });
  }

  try {
    const src = await applyOverlapCorrectionWithHistory(overlapId, action, createdBy, "correct");
    if (action !== "ignore") {
      await refreshOverlaps(src);
    }
    const [sections, overlaps] = await Promise.all([listSections(src), listOverlaps(src)]);
    return NextResponse.json({ success: true, sections, overlaps });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cadastre/sections/correct] POST", err);
    return NextResponse.json({ error: message }, { status: statusForOverlapError(message) });
  }
}
```

- [ ] **Step 4: Update `correct-batch/route.ts`**

Replace the entire content of `src/app/api/cadastre/sections/correct-batch/route.ts` with:

```ts
// src/app/api/cadastre/sections/correct-batch/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { applyOverlapCorrectionWithHistory, type OverlapAction } from "@/lib/cadastre/overlap-correction";
import { refreshOverlaps, listSections, listOverlaps } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";
export const maxDuration = 600;

// Fusion/suppression exclues du batch : trop sensibles pour un traitement en
// masse (cf. design doc, portée). Seules les règles de découpe + l'ignorance
// en masse sont couvertes.
const BATCH_ACTIONS = new Set<OverlapAction>(["clip_a", "clip_b", "auto", "ignore"]);

interface BatchResult {
  overlapId: number;
  ok: boolean;
  error?: string;
}

/**
 * POST /api/cadastre/sections/correct-batch — applique la MÊME règle à
 * plusieurs chevauchements en une requête. Traitement SÉQUENTIEL (pas de
 * `Promise.all`) : les corrections modifient des géométries partagées entre
 * sections, un traitement parallèle pourrait lire une géométrie déjà
 * périmée par un item précédent du même lot. Continue même si un item
 * échoue (ex. section déjà supprimée par un item précédent) — `results`
 * distingue réussites/échecs, pas de rollback global du lot. Chaque item
 * réussi capture + mute + enregistre son historique dans sa PROPRE
 * transaction (`applyOverlapCorrectionWithHistory`) — un item raté ne fait
 * disparaître ni la trace ni les mutations des items déjà réussis avant lui.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  let body: { overlapIds?: unknown; action?: string; sourceFichier?: string | null } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }

  const overlapIds = Array.isArray(body.overlapIds)
    ? body.overlapIds.filter((id): id is number => Number.isInteger(id))
    : [];
  const action = body.action as OverlapAction;
  if (overlapIds.length === 0 || !BATCH_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "overlapIds (liste non vide) et action valide requis" },
      { status: 400 },
    );
  }
  if (overlapIds.length > 500) {
    return NextResponse.json(
      { error: "Lot trop volumineux (max 500 chevauchements par appel)." },
      { status: 400 },
    );
  }

  const results: BatchResult[] = [];
  const touchedSources = new Set<string>();
  for (const overlapId of overlapIds) {
    try {
      const src = await applyOverlapCorrectionWithHistory(overlapId, action, createdBy, "correct-batch");
      if (action !== "ignore") touchedSources.add(src);
      results.push({ overlapId, ok: true });
    } catch (err) {
      console.error("[cadastre/sections/correct-batch] item failed", overlapId, err);
      results.push({ overlapId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const src of touchedSources) {
    await refreshOverlaps(src);
  }

  const viewSource = body.sourceFichier ?? null;
  const [sections, overlaps] = await Promise.all([
    listSections(viewSource),
    listOverlaps(viewSource),
  ]);
  return NextResponse.json({ results, sections, overlaps });
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit` — expect no new errors.

- [ ] **Step 6: Manual verification**

`npm run dev`, signed in as ADMIN, on `/cadastre/sections`, with a lot that has at least one PENDING overlap:
1. Resolve one overlap with `clip_a` (or any non-`ignore` action) via the single-correction UI. Confirm the response is unchanged.
2. In Prisma Studio, check `cad_history_entries` has a new `action='correct'` row whose `before.sections` has 2 entries (the pre-correction geometries of A and B).
3. Restore it (`POST /api/cadastre/history/<id>/restore`). Confirm both sections' geometries return to their pre-correction shape, and the overlap status/row is consistent again (may show as PENDING again after the next `refreshOverlaps`, which is expected — the revert restores DB state, not the derived overlap recompute).
4. Resolve an overlap with `ignore`. Confirm a new `action='correct'` entry with `before.sections = []`, `before.overlaps = [<the one overlap, status PENDING>]`. Restore it, confirm the overlap's status flips back from `IGNORED` to `PENDING` (this exercises the upsert fix from Task 1, Step 5 — a plain `DO NOTHING` would have silently failed here).
5. Trigger `correct-batch` on 2+ PENDING overlaps with `clip_a`. Confirm `cad_history_entries` gets one `action='correct-batch'` row per successfully-corrected overlap (not one aggregate row). Restore one of them, confirm only that overlap's sections revert, others stay corrected.
6. Re-run the `delete` E2E scenario from the original plan's Task 10 to confirm the upsert change to `reinsertLimiteSections`/`reinsertLimiteSectionOverlaps` (Task 1) didn't regress it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cadastre/overlap-correction.ts src/lib/cadastre/history.ts src/app/api/cadastre/sections/correct/route.ts src/app/api/cadastre/sections/correct-batch/route.ts
git commit -m "feat(cadastre): capture and restore history for correct and correct-batch"
```

---

### Task 4: `merge` action

**Files:**
- Modify: `src/lib/cadastre/history.ts`
- Modify: `src/app/api/cadastre/sections/merge/route.ts`

**Interfaces:**
- Consumes: `getSectionsFullByIds`, `getOverlapsForSections` (Task 1); `revertSectionsSnapshot` (Task 3, reused as-is for `merge`).

- [ ] **Step 1: Register `merge` in `REVERT_HANDLERS`**

In `src/lib/cadastre/history.ts`, extend the object from Task 3:

```ts
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
  correct: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-batch": (tx, before) => revertSectionsSnapshot(tx, before),
  merge: (tx, before) => revertSectionsSnapshot(tx, before),
};
```

- [ ] **Step 2: Rewrite `merge/route.ts`**

Replace the entire content of `src/app/api/cadastre/sections/merge/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import * as turf from "@turf/turf";
import {
  getSectionsFullByIds,
  getOverlapsForSections,
  updateSectionGeometry,
  deleteSection,
  refreshOverlaps,
} from "@/lib/cadastre/sections-data";
import { recordHistory, type SectionsDeleteSnapshot } from "@/lib/cadastre/history";

export const runtime = "nodejs";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

/** Concatène les anneaux en MultiPolygon — repli si `turf.union` échoue
 * (même stratégie que la dissolution de build-sections : aucun fragment perdu). */
function concatAsMultiPolygon(geoms: PolyGeom[]): GeoJSON.MultiPolygon {
  const coordinates: GeoJSON.Position[][][] = [];
  for (const g of geoms) {
    if (g.type === "Polygon") coordinates.push(g.coordinates);
    else coordinates.push(...g.coordinates);
  }
  return { type: "MultiPolygon", coordinates };
}

type MergeOutcome =
  | { kind: "not-found"; missing: number[] }
  | { kind: "ok"; keptId: number; keptNumSection: string | null; keptCommune: string | null; lots: string[] };

/**
 * POST /api/cadastre/sections/merge — fusion manuelle de 2+ sections choisies
 * librement (pas besoin d'un chevauchement détecté : fragments d'une même
 * section, section scindée à tort, zones voisines à regrouper).
 *
 * `{ sectionIds: number[] }` dans l'ordre de sélection : la PREMIÈRE conserve
 * ses attributs (numéro, commune, lot), les autres sont supprimées. Géométrie =
 * `turf.union` de l'ensemble (MultiPolygon si disjointes), repli concaténation
 * d'anneaux si l'union échoue. Les chevauchements des lots touchés sont
 * re-contrôlés.
 *
 * Capture un snapshot complet des N sections (y compris la géométrie
 * D'ORIGINE de la section conservée, avant fusion) et de leurs chevauchements,
 * AVANT toute mutation, dans la même transaction — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  let body: { sectionIds?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const ids = Array.isArray(body.sectionIds)
    ? Array.from(new Set(body.sectionIds.map(Number).filter(Number.isInteger)))
    : [];
  if (ids.length < 2) {
    return NextResponse.json({ error: "Au moins 2 sectionIds valides requis" }, { status: 400 });
  }

  try {
    const outcome = await prisma.$transaction(
      async (tx): Promise<MergeOutcome> => {
        const rows = await getSectionsFullByIds(ids, tx);
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((r) => r.id));
          return { kind: "not-found", missing: ids.filter((id) => !found.has(id)) };
        }
        const overlaps = await getOverlapsForSections(ids, tx);
        const before: SectionsDeleteSnapshot = { sections: rows, overlaps };

        const geoms = rows.map((r) => r.geomGeoJson);
        let merged: PolyGeom;
        try {
          const u = turf.union(turf.featureCollection(geoms.map((g) => turf.feature(g))));
          merged = (u?.geometry as PolyGeom | undefined) ?? concatAsMultiPolygon(geoms);
        } catch {
          merged = concatAsMultiPolygon(geoms);
        }

        const kept = rows[0];
        await updateSectionGeometry(kept.id, merged, areaM2(merged), tx);
        for (const r of rows.slice(1)) await deleteSection(r.id, tx);

        await recordHistory(tx, {
          scope: "sections",
          scopeKey: kept.syscolCommune,
          action: "merge",
          summary: `Fusion de ${rows.length} sections en ${kept.numSection ?? "#" + kept.id}${kept.commune ? ` (${kept.commune})` : ""}`,
          before,
          after: {},
          createdBy,
        });

        return {
          kind: "ok",
          keptId: kept.id,
          keptNumSection: kept.numSection,
          keptCommune: kept.commune,
          lots: Array.from(new Set(rows.map((r) => r.sourceFichier))),
        };
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: `Section(s) introuvable(s) : ${outcome.missing.join(", ")}` }, { status: 404 });
    }

    for (const src of outcome.lots) await refreshOverlaps(src);

    return NextResponse.json({ success: true, keptId: outcome.keptId, deleted: ids.length - 1 });
  } catch (err) {
    console.error("[cadastre/sections/merge] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` — expect no new errors.

- [ ] **Step 4: Manual verification**

`npm run dev`, signed in as ADMIN, on `/cadastre/sections`:
1. Select 2+ sections and merge them. Confirm the response is unchanged (`{success, keptId, deleted}`).
2. In Prisma Studio, check `cad_history_entries` has a new `action='merge'` row whose `before.sections` has N entries, including the KEPT section's geometry as it was **before** the merge (not the merged one).
3. Restore it. Confirm: the kept section's geometry returns to its original (pre-merge) shape (exercises the upsert fix — the kept row still existed, `DO NOTHING` would have silently kept the merged geometry), and every deleted section reappears with its original id and geometry.
4. Merge sections spanning two different `sourceFichier` lots (if available in your test data) and confirm both lots' overlaps get refreshed and both are captured in `before.sections`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cadastre/history.ts src/app/api/cadastre/sections/merge/route.ts
git commit -m "feat(cadastre): capture and restore history for the merge action"
```

---

### Task 5: `nicad-fill` action

**Files:**
- Modify: `src/lib/cadastre/nicad-fill-missing.ts`
- Modify: `src/lib/cadastre/history.ts`
- Modify: `src/app/api/cadastre/sections/nicad-fill/route.ts`

**Interfaces:**
- Changes: `fillMissingNicadForSection(section, numSection, options, db?)` now returns `Promise<{ result: NicadFillResult; snapshot: NicadFillSnapshot }>` instead of `Promise<NicadFillResult>` (breaking change, its one call site — `nicad-fill/route.ts` — is updated in this task; `fillMissingNicadForAnalysis`, the other exported function in this file, is untouched and out of scope).
- Produces: `interface NicadFillSnapshot { analyses: NicadFillAnalysisSnapshot[] }`, `interface NicadFillAnalysisSnapshot { analysisId, correctedGeoJsonBefore, resolvedErrorIds, statsBefore }`.

- [ ] **Step 1: Widen `resolveMissingNicadErrors` and `patchAnalysisStatsAfterNicadFill`**

In `src/lib/cadastre/nicad-fill-missing.ts`, add the `Db` import right after the existing imports (below `import { prisma } from "@/lib/prisma";`):

```ts
import type { Db } from "@/lib/cadastre/sections-data";
import type { Prisma } from "@prisma/client";
```

Replace:

```ts
/** Résout les erreurs MISSING_NICAD des parcelles d'`assignedIdx` par égalité de géométrie (cf. commentaire `geometryApproxEqual`). */
async function resolveMissingNicadErrors(
  analysisId: number,
  features: GeoFeature[],
  assignedIdx: number[],
): Promise<number[]> {
  if (assignedIdx.length === 0) return [];
  const missingErrors = await prisma.topologicalError.findMany({
    where: { analysisId, errorType: "MISSING_NICAD", corrected: false },
    select: { id: true, geometry: true },
  });
  if (missingErrors.length === 0) return [];
  const resolvedErrorIds: number[] = [];
  for (const idx of assignedIdx) {
    const geom = features[idx].geometry;
    const match = missingErrors.find((e) => geometryApproxEqual(e.geometry, geom));
    if (match) resolvedErrorIds.push(match.id);
  }
  return resolvedErrorIds;
}
```

with:

```ts
/** Résout les erreurs MISSING_NICAD des parcelles d'`assignedIdx` par égalité de géométrie (cf. commentaire `geometryApproxEqual`). */
async function resolveMissingNicadErrors(
  analysisId: number,
  features: GeoFeature[],
  assignedIdx: number[],
  db: Db = prisma,
): Promise<number[]> {
  if (assignedIdx.length === 0) return [];
  const missingErrors = await db.topologicalError.findMany({
    where: { analysisId, errorType: "MISSING_NICAD", corrected: false },
    select: { id: true, geometry: true },
  });
  if (missingErrors.length === 0) return [];
  const resolvedErrorIds: number[] = [];
  for (const idx of assignedIdx) {
    const geom = features[idx].geometry;
    const match = missingErrors.find((e) => geometryApproxEqual(e.geometry, geom));
    if (match) resolvedErrorIds.push(match.id);
  }
  return resolvedErrorIds;
}
```

Replace:

```ts
async function patchAnalysisStatsAfterNicadFill(
  analysisId: number,
  resolvedCount: number,
): Promise<void> {
  if (resolvedCount <= 0) return;
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { errorCount: true, totalFeatures: true, conformityScore: true, summaryStats: true },
  });
  if (!analysis) return;

  const prevStats = (analysis.summaryStats as Record<string, unknown> | null) ?? {};
  const prevQgis = (prevStats.qgisControl as Record<string, unknown> | null) ?? {};
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  const totalFeatures = analysis.totalFeatures ?? 0;
  const prevScore = Number(analysis.conformityScore) || 0;
  const newScore =
    totalFeatures > 0
      ? Math.max(0, Math.min(100, Math.round((prevScore + (resolvedCount / totalFeatures) * 100) * 10) / 10))
      : prevScore;

  const summaryStats = {
    ...prevStats,
    conformeCount: num(prevStats.conformeCount) + resolvedCount,
    nonConformeCount: Math.max(0, num(prevStats.nonConformeCount) - resolvedCount),
    missingNicadCount: Math.max(0, num(prevStats.missingNicadCount) - resolvedCount),
    withoutNicadCount: Math.max(0, num(prevStats.withoutNicadCount) - resolvedCount),
    withNicadCount: num(prevStats.withNicadCount) + resolvedCount,
    validNicad16Count: num(prevStats.validNicad16Count) + resolvedCount,
    conformityScore: newScore,
    qgisControl: {
      ...prevQgis,
      parcellesAvecNicad: num(prevQgis.parcellesAvecNicad) + resolvedCount,
      parcellesSansNicad: Math.max(0, num(prevQgis.parcellesSansNicad) - resolvedCount),
      nicadValide16: num(prevQgis.nicadValide16) + resolvedCount,
    },
  };

  await prisma.analysis.update({
    where: { id: analysisId },
    data: {
      errorCount: Math.max(0, (analysis.errorCount ?? 0) - resolvedCount),
      conformityScore: newScore.toString(),
      summaryStats: summaryStats as object,
    },
  });
}
```

with:

```ts
interface NicadFillStatsSnapshot {
  errorCount: number;
  conformityScore: string;
  summaryStats: Prisma.JsonValue;
}

/** Comme avant, mais renvoie les valeurs PRÉ-patch (`null` si `resolvedCount <= 0`,
 * cas où rien n'est modifié) — nécessaire pour capturer un `before` restaurable. */
async function patchAnalysisStatsAfterNicadFill(
  analysisId: number,
  resolvedCount: number,
  db: Db = prisma,
): Promise<NicadFillStatsSnapshot | null> {
  if (resolvedCount <= 0) return null;
  const analysis = await db.analysis.findUnique({
    where: { id: analysisId },
    select: { errorCount: true, totalFeatures: true, conformityScore: true, summaryStats: true },
  });
  if (!analysis) return null;

  const statsBefore: NicadFillStatsSnapshot = {
    errorCount: analysis.errorCount ?? 0,
    conformityScore: String(analysis.conformityScore ?? "0"),
    summaryStats: analysis.summaryStats,
  };

  const prevStats = (analysis.summaryStats as Record<string, unknown> | null) ?? {};
  const prevQgis = (prevStats.qgisControl as Record<string, unknown> | null) ?? {};
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);

  const totalFeatures = analysis.totalFeatures ?? 0;
  const prevScore = Number(analysis.conformityScore) || 0;
  const newScore =
    totalFeatures > 0
      ? Math.max(0, Math.min(100, Math.round((prevScore + (resolvedCount / totalFeatures) * 100) * 10) / 10))
      : prevScore;

  const summaryStats = {
    ...prevStats,
    conformeCount: num(prevStats.conformeCount) + resolvedCount,
    nonConformeCount: Math.max(0, num(prevStats.nonConformeCount) - resolvedCount),
    missingNicadCount: Math.max(0, num(prevStats.missingNicadCount) - resolvedCount),
    withoutNicadCount: Math.max(0, num(prevStats.withoutNicadCount) - resolvedCount),
    withNicadCount: num(prevStats.withNicadCount) + resolvedCount,
    validNicad16Count: num(prevStats.validNicad16Count) + resolvedCount,
    conformityScore: newScore,
    qgisControl: {
      ...prevQgis,
      parcellesAvecNicad: num(prevQgis.parcellesAvecNicad) + resolvedCount,
      parcellesSansNicad: Math.max(0, num(prevQgis.parcellesSansNicad) - resolvedCount),
      nicadValide16: num(prevQgis.nicadValide16) + resolvedCount,
    },
  };

  await db.analysis.update({
    where: { id: analysisId },
    data: {
      errorCount: Math.max(0, (analysis.errorCount ?? 0) - resolvedCount),
      conformityScore: newScore.toString(),
      summaryStats: summaryStats as object,
    },
  });

  return statsBefore;
}
```

- [ ] **Step 2: Rewrite `fillMissingNicadForSection`**

Replace:

```ts
export async function fillMissingNicadForSection(
  section: { geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string },
  numSection: string,
  options: { dryRun: boolean },
): Promise<NicadFillResult> {
  const result: NicadFillResult = {
    analysesUpdated: 0,
    parcelsAssigned: 0,
    errorsResolved: 0,
    analysisIds: [],
    plans: [],
    unresolvedCount: 0,
  };
  const normalizedSection = normalizeSection(numSection) ?? numSection;

  const analyses = await prisma.analysis.findMany({
    where: { fileName: section.sourceFichier },
    select: { id: true, correctedData: true, geojsonKey: true, geoJsonData: true },
  });
  if (analyses.length === 0) return result;

  const sectionPoly = turf.feature(section.geomGeoJson);

  for (const analysis of analyses) {
    const raw =
      analysis.correctedData ??
      (await loadGeoJsonFromKey(analysis.geojsonKey)) ??
      analysis.geoJsonData;
    if (!raw) continue;

    let geoJson: GeoFC;
    try {
      geoJson = JSON.parse(raw);
    } catch {
      continue;
    }
    const features = geoJson.features ?? [];
    if (features.length === 0) continue;

    const usedNicads = new Set<string>();
    for (const f of features) {
      const n = extractNicad(f.properties);
      if (n) usedNicads.add(n);
    }

    const outcome = await fillMissingNicadInFeatures(features, sectionPoly, normalizedSection, usedNicads);
    if (outcome.missingCount === 0) continue;
    if (outcome.assignedIdx.length === 0) {
      result.unresolvedCount += outcome.missingCount;
      continue;
    }

    result.plans.push({
      analysisId: analysis.id,
      count: outcome.assignedIdx.length,
      fromParcelle: normalizeNumeroParcelle(String(outcome.firstNum)).value ?? String(outcome.firstNum),
      toParcelle: normalizeNumeroParcelle(String(outcome.lastNum)).value ?? String(outcome.lastNum),
      viaCommune2026: outcome.viaCommune2026,
      communeApprox: outcome.communeApprox,
    });
    result.parcelsAssigned += outcome.assignedIdx.length;
    result.unresolvedCount += outcome.missingCount - outcome.assignedIdx.length;

    if (options.dryRun) continue;

    const resolvedErrorIds = await resolveMissingNicadErrors(analysis.id, features, outcome.assignedIdx);

    const correctedGeoJson = JSON.stringify(geoJson);
    const txResults = await prisma.$transaction([
      prisma.analysis.update({
        where: { id: analysis.id },
        data: { correctedData: correctedGeoJson },
      }),
      ...(resolvedErrorIds.length > 0
        ? [
            prisma.topologicalError.updateMany({
              where: { id: { in: resolvedErrorIds } },
              data: { corrected: true },
            }),
          ]
        : []),
    ]);
    if (analysis.geojsonKey) {
      try {
        await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
      } catch {
        /* ignore : correctedData reste la source d'affichage */
      }
    }

    result.analysesUpdated++;
    result.analysisIds.push(analysis.id);
    if (resolvedErrorIds.length > 0) {
      const resolvedCount = (txResults[1] as { count: number }).count;
      result.errorsResolved += resolvedCount;
      await patchAnalysisStatsAfterNicadFill(analysis.id, resolvedCount);
    }
  }

  return result;
}
```

with:

```ts
export interface NicadFillAnalysisSnapshot {
  analysisId: number;
  correctedGeoJsonBefore: string;
  resolvedErrorIds: number[];
  statsBefore: NicadFillStatsSnapshot | null;
}

export interface NicadFillSnapshot {
  analyses: NicadFillAnalysisSnapshot[];
}

export async function fillMissingNicadForSection(
  section: { geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string },
  numSection: string,
  options: { dryRun: boolean },
  db: Db = prisma,
): Promise<{ result: NicadFillResult; snapshot: NicadFillSnapshot }> {
  const result: NicadFillResult = {
    analysesUpdated: 0,
    parcelsAssigned: 0,
    errorsResolved: 0,
    analysisIds: [],
    plans: [],
    unresolvedCount: 0,
  };
  const snapshot: NicadFillSnapshot = { analyses: [] };
  const normalizedSection = normalizeSection(numSection) ?? numSection;

  const analyses = await db.analysis.findMany({
    where: { fileName: section.sourceFichier },
    select: { id: true, correctedData: true, geojsonKey: true, geoJsonData: true },
  });
  if (analyses.length === 0) return { result, snapshot };

  const sectionPoly = turf.feature(section.geomGeoJson);

  for (const analysis of analyses) {
    const raw =
      analysis.correctedData ??
      (await loadGeoJsonFromKey(analysis.geojsonKey)) ??
      analysis.geoJsonData;
    if (!raw) continue;

    let geoJson: GeoFC;
    try {
      geoJson = JSON.parse(raw);
    } catch {
      continue;
    }
    const features = geoJson.features ?? [];
    if (features.length === 0) continue;

    const usedNicads = new Set<string>();
    for (const f of features) {
      const n = extractNicad(f.properties);
      if (n) usedNicads.add(n);
    }

    const outcome = await fillMissingNicadInFeatures(features, sectionPoly, normalizedSection, usedNicads);
    if (outcome.missingCount === 0) continue;
    if (outcome.assignedIdx.length === 0) {
      result.unresolvedCount += outcome.missingCount;
      continue;
    }

    result.plans.push({
      analysisId: analysis.id,
      count: outcome.assignedIdx.length,
      fromParcelle: normalizeNumeroParcelle(String(outcome.firstNum)).value ?? String(outcome.firstNum),
      toParcelle: normalizeNumeroParcelle(String(outcome.lastNum)).value ?? String(outcome.lastNum),
      viaCommune2026: outcome.viaCommune2026,
      communeApprox: outcome.communeApprox,
    });
    result.parcelsAssigned += outcome.assignedIdx.length;
    result.unresolvedCount += outcome.missingCount - outcome.assignedIdx.length;

    if (options.dryRun) continue;

    const resolvedErrorIds = await resolveMissingNicadErrors(analysis.id, features, outcome.assignedIdx, db);

    const correctedGeoJson = JSON.stringify(geoJson);
    await db.analysis.update({
      where: { id: analysis.id },
      data: { correctedData: correctedGeoJson },
    });
    let resolvedCount = 0;
    if (resolvedErrorIds.length > 0) {
      const updateResult = await db.topologicalError.updateMany({
        where: { id: { in: resolvedErrorIds } },
        data: { corrected: true },
      });
      resolvedCount = updateResult.count;
    }
    if (analysis.geojsonKey) {
      try {
        await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
      } catch {
        /* ignore : correctedData reste la source d'affichage */
      }
    }

    result.analysesUpdated++;
    result.analysisIds.push(analysis.id);
    let statsBefore: NicadFillStatsSnapshot | null = null;
    if (resolvedCount > 0) {
      result.errorsResolved += resolvedCount;
      statsBefore = await patchAnalysisStatsAfterNicadFill(analysis.id, resolvedCount, db);
    }

    snapshot.analyses.push({
      analysisId: analysis.id,
      correctedGeoJsonBefore: raw,
      resolvedErrorIds,
      statsBefore,
    });
  }

  return { result, snapshot };
}
```

- [ ] **Step 3: Add `revertNicadFill` to `history.ts`, register it**

Add the import (extend the existing `import type { Prisma } from "@prisma/client";` usage — already present — no new import line needed for `Prisma`), then right after `revertSectionsSnapshot`, insert:

```ts
/** Revert de `nicad-fill` : réécrit `Analysis.correctedData`, les stats
 * agrégées (`errorCount`/`conformityScore`/`summaryStats`) et remet
 * `corrected = false` sur les `TopologicalError` que l'attribution avait
 * résolues — une entrée par `Analysis` effectivement modifiée par l'appel
 * d'origine (une section peut couvrir plusieurs tuiles/analyses). */
async function revertNicadFill(tx: Prisma.TransactionClient, before: unknown): Promise<void> {
  const snapshot = before as import("@/lib/cadastre/nicad-fill-missing").NicadFillSnapshot;
  if (!Array.isArray(snapshot?.analyses)) {
    throw new Error("Snapshot d'attribution NICAD invalide — impossible de restaurer.");
  }
  for (const entry of snapshot.analyses) {
    await tx.analysis.update({
      where: { id: entry.analysisId },
      data: {
        correctedData: entry.correctedGeoJsonBefore,
        ...(entry.statsBefore
          ? {
              errorCount: entry.statsBefore.errorCount,
              conformityScore: entry.statsBefore.conformityScore,
              summaryStats: entry.statsBefore.summaryStats as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    if (entry.resolvedErrorIds.length > 0) {
      await tx.topologicalError.updateMany({
        where: { id: { in: entry.resolvedErrorIds } },
        data: { corrected: false },
      });
    }
  }
}
```

Update `REVERT_HANDLERS`:

```ts
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
  correct: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-batch": (tx, before) => revertSectionsSnapshot(tx, before),
  merge: (tx, before) => revertSectionsSnapshot(tx, before),
  "nicad-fill": (tx, before) => revertNicadFill(tx, before),
};
```

- [ ] **Step 4: Update `nicad-fill/route.ts`**

Replace the entire content of `src/app/api/cadastre/sections/nicad-fill/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSection } from "@/lib/cadastre/sections-data";
import { fillMissingNicadForSection } from "@/lib/cadastre/nicad-fill-missing";
import { recordHistory } from "@/lib/cadastre/history";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/nicad-fill — attribue un NICAD aux parcelles
 * d'une section numérotée qui n'en ont AUCUN, par incrémentation depuis le
 * dernier numéro de parcelle connu dans la section, en chaînant vers la plus
 * proche (cf. `nicad-fill-missing.ts`, docs/CONCEPTS-TRAITEMENT-DXF.md
 * §11 quinquies).
 *
 * `dryRun: true` calcule le plan (nombre de parcelles, plage de numéros) SANS
 * écrire en base — sert d'aperçu avant confirmation côté client, et n'écrit
 * donc aucune entrée d'historique.
 *
 * Hors `dryRun`, capture un snapshot par `Analysis` effectivement modifiée
 * (GeoJSON avant écriture + erreurs résolues + stats agrégées avant patch) et
 * l'enregistre comme UNE entrée d'historique restaurable couvrant tout
 * l'appel, dans la même transaction que les écritures — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  let body: { sectionId?: number; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const sectionId = Number(body.sectionId);
  if (!Number.isInteger(sectionId)) {
    return NextResponse.json({ error: "sectionId requis" }, { status: 400 });
  }

  try {
    const section = await getSection(sectionId);
    if (!section) {
      return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
    }
    if (!section.numSection) {
      return NextResponse.json(
        { error: "Cette section n'a pas encore de numéro — attribuez-lui-en un d'abord." },
        { status: 400 },
      );
    }
    const numSection = section.numSection;
    const dryRun = body.dryRun === true;

    if (dryRun) {
      const { result } = await fillMissingNicadForSection(section, numSection, { dryRun: true });
      return NextResponse.json({ success: true, sectionId, dryRun: true, result });
    }

    const { result } = await prisma.$transaction(
      async (tx) => {
        const out = await fillMissingNicadForSection(section, numSection, { dryRun: false }, tx);
        if (out.snapshot.analyses.length > 0) {
          await recordHistory(tx, {
            scope: "sections",
            scopeKey: section.syscolCommune,
            action: "nicad-fill",
            summary: `Attribution NICAD sur la section ${numSection}${section.commune ? ` (${section.commune})` : ""} — ${out.result.parcelsAssigned} parcelle(s)`,
            before: out.snapshot,
            after: {},
            createdBy,
          });
        }
        return out;
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    return NextResponse.json({ success: true, sectionId, dryRun: false, result });
  } catch (err) {
    console.error("[cadastre/sections/nicad-fill] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit` — expect no new errors. If the inline `import("@/lib/cadastre/nicad-fill-missing").NicadFillSnapshot` type in `history.ts` (Step 3) causes any resolution issue, replace it with a top-level `import type { NicadFillSnapshot } from "@/lib/cadastre/nicad-fill-missing";` at the top of `history.ts` and use `NicadFillSnapshot` directly instead — both are equivalent, the inline form just avoids adding a new top-of-file import line.

- [ ] **Step 6: Manual verification**

`npm run dev`, signed in as ADMIN, on `/cadastre/sections`, with a numbered section that has parcels missing a NICAD:
1. Run `dryRun: true` first — confirm the plan preview still works and `cad_history_entries` gets NO new row.
2. Run `dryRun: false`. Confirm the response `result` is unchanged in shape.
3. In Prisma Studio, check `cad_history_entries` has a new `action='nicad-fill'` row whose `before.analyses` has one entry per touched `Analysis`, each with `correctedGeoJsonBefore` containing the OLD (pre-fill) GeoJSON.
4. Restore it. Confirm: the affected parcels' NICAD reverts to missing/absent, any `TopologicalError` resolved by the fill go back to `corrected: false`, and `Analysis.errorCount`/`conformityScore`/`summaryStats` return to their pre-fill values (compare against what you noted in step 3, or against a fresh `analyzeGeoJSON` re-run if in doubt).
5. Confirm `/map/[analysisId]`'s error count/conformity display (if you check it) matches the reverted stats after a page reload.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cadastre/nicad-fill-missing.ts src/lib/cadastre/history.ts src/app/api/cadastre/sections/nicad-fill/route.ts
git commit -m "feat(cadastre): capture and restore history for the nicad-fill action"
```

---

### Task 6: `map-delete` and `map-rename` actions

**Files:**
- Modify: `src/lib/cadastre/history.ts`
- Modify: `src/app/api/analyses/[id]/features/delete/route.ts`
- Modify: `src/app/api/analyses/[id]/features/update-nicad/route.ts`

**Interfaces:**
- Produces: `interface MapEditSnapshot { correctedGeoJson: string; errorPatches: { errorId: number; corrected: boolean }[] }`, `revertMap` (the first `RevertFn` that actually uses its `scopeKey` argument — `Analysis.id`, gated behind the third parameter added in Task 2).

- [ ] **Step 1: Add `MapEditSnapshot` + `revertMap` to `history.ts`, register both actions**

Right after `revertNicadFill`, insert:

```ts
export interface MapEditSnapshot {
  correctedGeoJson: string;
  errorPatches: { errorId: number; corrected: boolean }[];
}

/** Revert partagé par `map-delete` et `map-rename` — réécrit
 * `Analysis.correctedData` avec le blob capturé AVANT l'édition et remet les
 * `TopologicalError.corrected` visés à leur état d'alors. Même logique que la
 * route déjà existante `/api/analyses/[id]/history/restore` (utilisée par
 * l'annuler/rétablir en mémoire côté client) — dupliquée ici plutôt
 * qu'appelée en HTTP, car ce revert doit s'exécuter DANS la transaction du
 * generic restore route, pas dans un appel réseau séparé. `scopeKey` porte
 * l'`Analysis.id` (cf. `String(analysisId)` posé par les routes d'édition à
 * la capture) — sans lui, ce revert ne saurait pas QUELLE analyse réécrire. */
async function revertMap(
  tx: Prisma.TransactionClient,
  before: unknown,
  scopeKey: string | null,
): Promise<void> {
  const snapshot = before as MapEditSnapshot;
  if (typeof snapshot?.correctedGeoJson !== "string" || !Array.isArray(snapshot.errorPatches)) {
    throw new Error("Snapshot de modification carte invalide — impossible de restaurer.");
  }
  const analysisId = Number(scopeKey);
  if (!Number.isInteger(analysisId)) {
    throw new Error("scopeKey invalide pour une restauration carte (analysisId attendu).");
  }

  let totalFeatures: number | undefined;
  try {
    const parsed = JSON.parse(snapshot.correctedGeoJson) as { features?: unknown[] };
    totalFeatures = Array.isArray(parsed.features) ? parsed.features.length : undefined;
  } catch {
    totalFeatures = undefined;
  }

  await tx.analysis.update({
    where: { id: analysisId },
    data: {
      correctedData: snapshot.correctedGeoJson,
      ...(totalFeatures != null ? { totalFeatures } : {}),
    },
  });

  const correctedIds = snapshot.errorPatches.filter((p) => p.corrected).map((p) => p.errorId);
  const uncorrectedIds = snapshot.errorPatches.filter((p) => !p.corrected).map((p) => p.errorId);
  if (correctedIds.length > 0) {
    await tx.topologicalError.updateMany({
      where: { analysisId, id: { in: correctedIds } },
      data: { corrected: true },
    });
  }
  if (uncorrectedIds.length > 0) {
    await tx.topologicalError.updateMany({
      where: { analysisId, id: { in: uncorrectedIds } },
      data: { corrected: false },
    });
  }
}
```

Update `REVERT_HANDLERS` (final form of this object after this plan):

```ts
const REVERT_HANDLERS: Partial<Record<string, RevertFn>> = {
  delete: (tx, before) => revertDelete(tx, before),
  numero: (tx, before) => revertNumero(tx, before),
  correct: (tx, before) => revertSectionsSnapshot(tx, before),
  "correct-batch": (tx, before) => revertSectionsSnapshot(tx, before),
  merge: (tx, before) => revertSectionsSnapshot(tx, before),
  "nicad-fill": (tx, before) => revertNicadFill(tx, before),
  "map-delete": revertMap,
  "map-rename": revertMap,
};
```

- [ ] **Step 2: Instrument `features/delete/route.ts`**

Replace the entire content of `src/app/api/analyses/[id]/features/delete/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import { resolveLocator, type GeoFeature, type Locator } from "@/lib/analyses/feature-locator";
import { recordHistory, type MapEditSnapshot } from "@/lib/cadastre/history";

type Params = Promise<{ id: string }>;

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

/**
 * POST /api/analyses/[id]/features/delete
 *
 * Supprime des parcelles de l'analyse depuis la table attributaire. Chaque
 * parcelle est identifiée par un localisateur (point intérieur, emprise ou
 * NICAD). L'édition est écrite dans `correctedData` (source lue par les tuiles
 * vectorielles), de façon cohérente avec le flux de correction des erreurs. Les
 * erreurs de topologie dont l'index est fourni sont marquées corrigées.
 *
 * Capture l'état AVANT édition (GeoJSON + statut `corrected` PRÉCÉDENT des
 * erreurs ciblées) et l'enregistre comme entrée d'historique restaurable,
 * dans la même transaction que l'écriture — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return NextResponse.json({ error: "ID d'analyse invalide" }, { status: 400 });
  }

  let body: { locators?: Locator[]; errorIds?: number[] } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const locators = Array.isArray(body.locators) ? body.locators : [];
  if (locators.length === 0) {
    return NextResponse.json({ error: "Aucune parcelle à supprimer" }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  // Prime les corrections déjà appliquées, sinon le GeoJSON persisté sur disque,
  // sinon le champ inline (legacy) — même priorité que la route de correction.
  const rawGeoJson =
    analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!rawGeoJson) return NextResponse.json({ error: "GeoJSON introuvable" }, { status: 400 });

  let geoJson: GeoFC;
  try {
    geoJson = JSON.parse(rawGeoJson);
  } catch {
    return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 });
  }

  const features = geoJson.features ?? [];
  const removed = new Set<number>();
  const notFound: Locator[] = [];
  for (const loc of locators) {
    const idx = resolveLocator(features, loc, removed);
    if (idx >= 0) removed.add(idx);
    else notFound.push(loc);
  }

  if (removed.size === 0) {
    return NextResponse.json(
      { error: "Parcelle(s) introuvable(s) dans le GeoJSON", notFound },
      { status: 404 }
    );
  }

  geoJson.features = features.filter((_, i) => !removed.has(i));
  const correctedGeoJson = JSON.stringify(geoJson);
  const errorIds = (body.errorIds ?? []).filter((n) => Number.isInteger(n));

  await prisma.$transaction(async (tx) => {
    const priorErrors =
      errorIds.length > 0
        ? await tx.topologicalError.findMany({
            where: { analysisId, id: { in: errorIds } },
            select: { id: true, corrected: true },
          })
        : [];

    await tx.analysis.update({
      where: { id: analysisId },
      data: { correctedData: correctedGeoJson, totalFeatures: geoJson.features.length },
    });
    if (errorIds.length > 0) {
      await tx.topologicalError.updateMany({
        where: { analysisId, id: { in: errorIds } },
        data: { corrected: true },
      });
    }

    const before: MapEditSnapshot = {
      correctedGeoJson: rawGeoJson,
      errorPatches: priorErrors.map((e) => ({ errorId: e.id, corrected: e.corrected })),
    };
    const after: MapEditSnapshot = {
      correctedGeoJson,
      errorPatches: errorIds.map((eid) => ({ errorId: eid, corrected: true })),
    };
    await recordHistory(tx, {
      scope: "map",
      scopeKey: String(analysisId),
      action: "map-delete",
      summary: `Suppression de ${removed.size} parcelle(s) sur l'analyse #${analysisId}`,
      before,
      after,
      createdBy,
    });
  });

  // Persiste aussi le GeoJSON de base (clé disque) quand il existe, pour que les
  // recalculs repartant de la source reflètent les suppressions. Hors transaction
  // (le store fichier n'est pas transactionnel) ; `correctedData` fait foi pour
  // l'affichage, on n'échoue donc pas l'appel si l'écriture disque échoue.
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  return NextResponse.json({
    success: true,
    deleted: removed.size,
    remaining: geoJson.features.length,
    notFound: notFound.length,
    correctedGeoJson,
    // Blob exact d'avant édition (utilisé par l'historique annuler/rétablir côté
    // client) : `rawGeoJson` n'a pas été muté, seul l'objet `geoJson` parsé l'a été.
    previousCorrectedGeoJson: rawGeoJson,
  });
}
```

(`requireSession()` is replaced by an inline `auth()` call so the route can read `session.user.id` for `createdBy` — same 401 behavior and message, `requireSession()` is unused here now but stays exported/used by the many other `/api/analyses/[id]/*` routes that don't need the session object itself.)

- [ ] **Step 3: Instrument `features/update-nicad/route.ts`**

Replace the entire content of `src/app/api/analyses/[id]/features/update-nicad/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadGeoJsonFromKey, writeGeoJsonByKey } from "@/lib/geo-storage";
import {
  resolveLocator,
  setFeatureNicad,
  type GeoFeature,
  type Locator,
} from "@/lib/analyses/feature-locator";
import { recordHistory, type MapEditSnapshot } from "@/lib/cadastre/history";

type Params = Promise<{ id: string }>;

type GeoFC = { type: "FeatureCollection"; features: GeoFeature[] };

/**
 * POST /api/analyses/[id]/features/update-nicad
 *
 * Réassigne le NICAD d'UNE parcelle (localisée par point/emprise/NICAD, cf.
 * `feature-locator`). Sert à résoudre une doublure en donnant un NICAD distinct à
 * l'occurrence sélectionnée, sans la supprimer. L'édition transite par
 * `correctedData` (source des tuiles) comme le reste du flux d'édition ; si un
 * `errorId` (erreur DUPLICATE de cette occurrence) est fourni, il est marqué
 * corrigé.
 *
 * Capture l'état AVANT édition (GeoJSON + statut `corrected` PRÉCÉDENT de
 * l'erreur ciblée) et l'enregistre comme entrée d'historique restaurable,
 * dans la même transaction que l'écriture — cf.
 * docs/superpowers/specs/2026-08-06-cadastre-history-restore-design.md.
 */
export async function POST(req: NextRequest, { params }: { params: Params }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  const createdBy = (session.user as { id?: string }).id ?? null;

  const { id } = await params;
  const analysisId = parseInt(id, 10);
  if (Number.isNaN(analysisId)) {
    return NextResponse.json({ error: "ID d'analyse invalide" }, { status: 400 });
  }

  let body: { locator?: Locator; nicad?: string; errorId?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const locator = body.locator;
  const nicad = typeof body.nicad === "string" ? body.nicad.trim() : "";
  if (!locator || (!locator.point && !locator.bbox && !locator.nicad)) {
    return NextResponse.json({ error: "Localisateur de parcelle manquant" }, { status: 400 });
  }
  if (!nicad) {
    return NextResponse.json({ error: "Nouveau NICAD requis" }, { status: 400 });
  }

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return NextResponse.json({ error: "Analyse non trouvée" }, { status: 404 });

  // Même priorité de source que la correction / suppression.
  const rawGeoJson =
    analysis.correctedData ?? (await loadGeoJsonFromKey(analysis.geojsonKey)) ?? analysis.geoJsonData;
  if (!rawGeoJson) return NextResponse.json({ error: "GeoJSON introuvable" }, { status: 400 });

  let geoJson: GeoFC;
  try {
    geoJson = JSON.parse(rawGeoJson);
  } catch {
    return NextResponse.json({ error: "GeoJSON invalide" }, { status: 400 });
  }

  const features = geoJson.features ?? [];
  const idx = resolveLocator(features, locator, new Set());
  if (idx < 0) {
    return NextResponse.json({ error: "Parcelle introuvable dans le GeoJSON" }, { status: 404 });
  }

  setFeatureNicad(features[idx], nicad);
  const correctedGeoJson = JSON.stringify(geoJson);
  const errorId = Number.isInteger(body.errorId) ? (body.errorId as number) : null;

  await prisma.$transaction(async (tx) => {
    const priorError =
      errorId !== null
        ? await tx.topologicalError.findUnique({ where: { id: errorId }, select: { id: true, corrected: true } })
        : null;

    await tx.analysis.update({
      where: { id: analysisId },
      data: { correctedData: correctedGeoJson },
    });
    if (errorId !== null) {
      await tx.topologicalError.updateMany({
        where: { analysisId, id: errorId },
        data: { corrected: true },
      });
    }

    const before: MapEditSnapshot = {
      correctedGeoJson: rawGeoJson,
      errorPatches: priorError ? [{ errorId: priorError.id, corrected: priorError.corrected }] : [],
    };
    const after: MapEditSnapshot = {
      correctedGeoJson,
      errorPatches: errorId !== null ? [{ errorId, corrected: true }] : [],
    };
    await recordHistory(tx, {
      scope: "map",
      scopeKey: String(analysisId),
      action: "map-rename",
      summary: `Réassignation du NICAD ${nicad} sur l'analyse #${analysisId}`,
      before,
      after,
      createdBy,
    });
  });

  // Persiste aussi le GeoJSON de base (clé disque) pour que les recalculs repartant
  // de la source reflètent la réassignation. Hors transaction (store non
  // transactionnel) ; `correctedData` fait foi pour l'affichage.
  if (analysis.geojsonKey) {
    try {
      await writeGeoJsonByKey(analysis.geojsonKey, correctedGeoJson);
    } catch {
      /* ignore : correctedData reste la source d'affichage */
    }
  }

  return NextResponse.json({
    success: true,
    nicad,
    correctedGeoJson,
    // Blob exact d'avant édition (utilisé par l'historique annuler/rétablir côté
    // client) : `rawGeoJson` n'a pas été muté, seule la feature parsée l'a été.
    previousCorrectedGeoJson: rawGeoJson,
  });
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit` — expect no new errors.

- [ ] **Step 5: Manual verification**

`npm run dev`, signed in, on `/map/[analysisId]` for an analysis with at least a couple of parcels:
1. Delete a parcel via the attribute table. Confirm the response shape is unchanged and the client's existing in-memory undo (Ctrl+Z) still works exactly as before (this plan does not touch `MapAnalysisClient.tsx`).
2. In Prisma Studio, check `cad_history_entries` has a new `action='map-delete'` row with `scope='map'`, `scopeKey='<analysisId>'`, and `before.correctedGeoJson` containing the deleted parcel.
3. `POST /api/cadastre/history/<id>/restore` (devtools fetch). Confirm the parcel reappears after reloading `/map/[analysisId]`, and a new `action='restore'` entry is created.
4. Reassign a NICAD via the "renommer" action. Repeat steps 2–3 for `action='map-rename'`.
5. Delete/rename a parcel that also has a linked `TopologicalError` (pass a real `errorId`), restore it, and confirm the error's `corrected` flag goes back to its previous value (not blindly `false` — test this with an error that was ALREADY `corrected: true` before your test edit, to confirm the "before" capture is a true snapshot and not an assumption).

- [ ] **Step 6: Commit**

```bash
git add src/lib/cadastre/history.ts src/app/api/analyses/[id]/features/delete/route.ts src/app/api/analyses/[id]/features/update-nicad/route.ts
git commit -m "feat(cadastre): capture and restore history for map-delete and map-rename"
```

---

### Task 7: Lint pass + full end-to-end verification across all 7 actions

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npx eslint .` — expect no errors in any file touched by this plan. Fix anything reported before proceeding.

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit` — expect no errors anywhere in the project.

- [ ] **Step 3: `GET /api/cadastre/history` sanity check**

With the dev server running and signed in, visit `/api/cadastre/history?scope=sections` and `/api/cadastre/history?scope=map`. Confirm entries from every action tested in Tasks 2–6 (`numero`, `correct`, `correct-batch`, `merge`, `nicad-fill`, `map-delete`, `map-rename`, plus the pre-existing `delete` and `restore`) show up with readable `summary` text and no `before`/`after` keys leaking into the list payload (unchanged contract from the original `delete` plan).

- [ ] **Step 4: `/cadastre/historique` and `CadHistoryPanel` sanity check**

Visit `/cadastre/historique` — confirm the "Modifications sections/parcelles" card lists the new `numero`/`correct`/`correct-batch`/`merge`/`nicad-fill` entries alongside `delete` (it already queries `scope: "sections"` with no `action` filter, cf. `src/app/cadastre/_actions/history.ts` — no change needed there). On `/cadastre/sections`, open the "Historique" panel (`CadHistoryPanel`, `scopeKey={null}`) and confirm every new action type renders a sensible summary and, for ADMIN, an enabled "Restaurer" button that succeeds (no more 400 "action non prise en charge" for any of the 7 actions covered by this plan).

- [ ] **Step 5: Regression check on `delete`**

Re-run the original `delete` E2E scenario (`docs/superpowers/plans/2026-08-06-cadastre-history-restore-delete.md`, Task 10, Step 3) end-to-end once more, since Task 1 changed the shared `reinsertLimiteSections`/`reinsertLimiteSectionOverlaps` helpers it depends on.

If any step fails, fix the responsible task's code before moving on — do not proceed to a follow-up plan with a known-broken restore path.

- [ ] **Step 6: Final commit (only if fixes were needed in this task)**

```bash
git add -A
git commit -m "fix(cadastre): address issues found during remaining-actions history E2E verification"
```

---

## Post-plan documentation update

Per this project's `CLAUDE.md` rule on documenting geospatial/topological processing concepts: once this plan is fully executed and verified, add a short entry to `docs/CONCEPTS-TRAITEMENT-DXF.md` covering the two new patterns introduced here — (1) upsert-based history reinsertion (`ON CONFLICT DO UPDATE` instead of `DO NOTHING`, needed once a revert target can still exist), and (2) per-item transactions for a batch endpoint that must keep partial-failure tolerance while still guaranteeing "no mutation without a trace" for each item that does succeed — with the file/function references from this plan. Reference the new doc entry from `docs/README.md`.
