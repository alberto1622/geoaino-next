# Migration en masse par import shapefile (NICAD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a shapefile containing a NICAD column into "Migration en masse", auto-identify the 2026 target (commune + section, simple and complex cases) for every NICAD found, show a preview table, and let the user confirm the basculement per row or in bulk.

**Architecture:** A new async `ImportJob` kind (`"bascule-nicad"`) reads the shapefile, extracts NICAD values, and runs the same identification logic already used by the interactive "Basculement 2013→2026" page (extracted into a shared module so both paths stay identical). The job's `report` field stores the full preview list — no database write happens during identification. A new server action then applies the real basculement (same shared logic) only for rows the user explicitly approves.

**Tech Stack:** Next.js Server Actions + Route Handlers (existing), Prisma/PostgreSQL, `shapefile` npm package, existing `ImportJob` async-job infrastructure (`src/lib/import/jobs.ts`), existing `FieldMappingModal`/`JobProgressSteps` UI components.

**Spec:** `docs/superpowers/specs/2026-09-19-migration-masse-shapefile-design.md`

## Global Constraints

- No Prisma migration needed: `ImportJob.kind`/`.phase` are plain `String` columns in the DB — only the TypeScript unions `JobKind`/`JobPhase` change.
- `identifierBasculement` and `basculerNicadAction` (`src/app/cadastre/_actions/nicad.ts`) must keep their exact current external behavior — the interactive "Basculement 2013→2026" page (`/cadastre/basculement`) must work identically after the refactor. This is verified by re-running the existing page manually after Task 1, before any new feature code is added.
- No automated test framework exists for cadastre server logic in this repo (only `scripts/test-llm-offline.ts` is automated). Verification steps in this plan use one-off `npx tsx -e "..."` scripts against the real dev database, matching the pattern already used elsewhere in this session (e.g. `desktop/scripts/test-machine-id.ts`).
- Never basculer automatiquement a row with `flags.length > 0` — the "Basculer les lignes sans drapeau" bulk button must only ever select `clean: true` rows (spec §"Décisions actées", point 2).
- `npx tsc --noEmit` and `npx eslint <changed files>` must be clean before every commit (project convention, `CLAUDE.md`).

---

## Task 1: Extract shared basculement logic into `lib/cadastre/basculement.ts`

**Files:**
- Create: `src/lib/cadastre/basculement.ts`
- Modify: `src/app/cadastre/_actions/nicad.ts:243-322` (the `identifierBasculement` function body) and `src/app/cadastre/_actions/nicad.ts:325-410` (the `basculerNicadAction` function body)
- Test: manual (see Step 4 below — no automated framework)

**Interfaces:**
- Produces (used by Task 3 and Task 4):
  ```ts
  export interface IdentificationResult {
    success: boolean;
    error?: string;
    dejaAJour?: boolean;
    nicad?: { syscol: string; section: string; numParcelle: string; full: string };
    commune2013?: { nomCommune: string; region: string | null; departement: string | null } | null;
    commune2026?: { nomCommune: string; region: string | null; departement: string | null } | null;
    correspondance?: {
      syscol2026: string;
      nomCommune2026: string;
      statut: string;
      typeChangement: string | null;
      departement2013: string | null;
      departement2026: string | null;
    } | null;
    sectionExisteEn2026?: boolean | null;
    flags: string[];
    clean?: boolean;
    proposition?: { syscolNouveau: string; sectionNouvelle?: string } | null;
  }
  export async function identifierBasculementNicad(nicadAncien: string): Promise<IdentificationResult>

  export interface BasculementInput {
    nicadAncien: string;
    syscolNouveau: string;
    sectionNouvelle?: string;
    motif?: string;
    userId: string;
  }
  export interface BasculementResult {
    success: boolean;
    error?: string;
    cas?: "simple" | "complexe";
    nicadAncien?: string;
    nicadNouveau?: string;
    nicadNouveauFormate?: string;
    sectionAncienne?: string;
    sectionNouvelle?: string;
    communeAncienne?: string;
    communeNouvelle?: string;
    description?: string;
  }
  export async function basculerNicadCore(input: BasculementInput): Promise<BasculementResult>
  ```

- [ ] **Step 1: Create `src/lib/cadastre/basculement.ts` with the extracted logic**

Copy the CURRENT bodies of `identifierBasculement` and `basculerNicadAction` from `src/app/cadastre/_actions/nicad.ts` verbatim, with these exact changes:
- Drop the `"use server"` directive (this is a plain library module, not a Server Actions file).
- Drop the zod schemas (`identifierSchema`, `basculeSchema`) and the `.parse(input)` calls — callers validate before calling.
- Drop `await requireUserId()` / the implicit auth — `basculerNicadCore` takes `userId` as an explicit input field instead of calling `requireUserId()` itself (a library function must not assume it's running inside a Server Action's request context).
- Rename `identifierBasculement` → `identifierBasculementNicad`, `basculerNicadAction` → `basculerNicadCore`.
- Move the two constants `SEUIL_SECTION_CONFIRME`, `SEUIL_SECTION_DECOUPE` and `TYPE_CHANGEMENT_LABELS` into this new file (they're only used by `identifierBasculementNicad`).
- Import everything these functions need directly in the new file: `formatNicadDisplay`, `basculerNicadSimple`, `basculerNicadComplexe`, `validateNicadFormat` from `@/lib/cadastre/nicad-logic`; `getCommune2013BySyscol`, `getCommune2026BySyscol`, `getCorrespondanceBySyscol2013`, `findSectionSpatialMatches`, `getSectionByKey`, `getLastNumParcelleGlobal`, `getNicadByCode`, `insertNicad`, `insertParcelle`, `updateNicadStatut`, `insertNicadHistorique` from `@/lib/cadastre/data`.

The full file must compile standalone — no leftover references to `z`, `requireUserId`, or anything from `_actions/_auth.ts`.

- [ ] **Step 2: Rewrite `_actions/nicad.ts`'s `identifierBasculement` and `basculerNicadAction` as thin wrappers**

Replace the body of `identifierBasculement` (keep the exported name, the zod schema, and the function signature exactly as they are today) with:

```ts
export async function identifierBasculement(input: z.infer<typeof identifierSchema>) {
  const data = identifierSchema.parse(input);
  await requireUserId();
  return identifierBasculementNicad(data.nicadAncien);
}
```

Replace the body of `basculerNicadAction` (keep the exported name, the zod schema `basculeSchema`, and the function signature exactly as they are today) with:

```ts
export async function basculerNicadAction(input: z.infer<typeof basculeSchema>) {
  const data = basculeSchema.parse(input);
  const userId = await requireUserId();
  const formatResult = validateNicadFormat(data.nicadAncien);
  if (!formatResult.valid) {
    return { success: false, error: `NICAD invalide: ${formatResult.errors.join(", ")}` };
  }
  return basculerNicadCore({
    nicadAncien: data.nicadAncien,
    syscolNouveau: data.syscolNouveau,
    sectionNouvelle: data.sectionNouvelle,
    motif: data.motif,
    userId,
  });
}
```

Add the import at the top of `_actions/nicad.ts`: `import { identifierBasculementNicad, basculerNicadCore } from "@/lib/cadastre/basculement";`

Delete now-unused imports/constants left dangling in `_actions/nicad.ts` after this move (`SEUIL_SECTION_CONFIRME`, `SEUIL_SECTION_DECOUPE`, `TYPE_CHANGEMENT_LABELS`, and any of `getCommune2013BySyscol`/`getCommune2026BySyscol`/`getCorrespondanceBySyscol2013`/`findSectionSpatialMatches`/`getSectionByKey`/`getLastNumParcelleGlobal`/`getNicadByCode`/`insertNicad`/`insertParcelle`/`updateNicadStatut`/`insertNicadHistorique`/`basculerNicadSimple`/`basculerNicadComplexe` that are no longer referenced directly in this file — check with `npx eslint` (unused-import rule will flag them).

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors related to `basculement.ts` or `nicad.ts`.

Run: `npx eslint src/lib/cadastre/basculement.ts src/app/cadastre/_actions/nicad.ts`
Expected: no output (clean).

- [ ] **Step 4: Manually verify the interactive "Basculement" page still behaves identically**

Start the dev server (`npm run dev`), sign in, go to `/cadastre/basculement`. Pick a real 2013 NICAD known to exist in the dev database (query one first):

```bash
npx tsx -e "
import { prisma } from './src/lib/prisma';
prisma.cadNicad.findFirst({ where: { version: '2013', statut: 'actif' } }).then(n => { console.log(n); return prisma.\$disconnect(); });
"
```

Enter that NICAD in the "NICAD d'origine" field, click "Identifier", confirm a proposal appears (or a "déjà à jour" / error message, depending on what that NICAD's commune correspondance looks like) exactly as it did before this refactor. Click "Basculer le NICAD" and confirm a result card appears with a new NICAD.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cadastre/basculement.ts src/app/cadastre/_actions/nicad.ts
git commit -m "refactor(cadastre): extraire la logique de basculement NICAD dans lib/cadastre/basculement.ts

Prepare le terrain pour la migration en masse par shapefile (spec
docs/superpowers/specs/2026-09-19-migration-masse-shapefile-design.md) :
identifierBasculement/basculerNicadAction deviennent de minces wrappers
(auth + validation) autour de fonctions reutilisables sans contexte
Server Action. Comportement de /cadastre/basculement inchange, verifie
manuellement.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Add `"bascule-nicad"` plumbing (JobKind, JobPhase, ShapefileTarget)

**Files:**
- Modify: `src/lib/import/jobs.ts:9` (`JobPhase`), `src/lib/import/jobs.ts:18` (`JobKind`)
- Modify: `src/lib/import/field-mapping.ts:11` (`ShapefileTarget`), and add a new exported constant + wire it into `targetFieldsFor` (`src/lib/import/field-mapping.ts:93-98`)
- Modify: `src/app/api/cadastre/import/inventory/route.ts:12` (`VALID_TARGETS`)
- Modify: `src/app/api/import-jobs/route.ts:33-38` (`shapefileTargetForKind`) and `src/app/api/import-jobs/route.ts:117` (the kind allow-list for SHP jobs)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 3, Task 5): `JobKind` includes `"bascule-nicad"`; `JobPhase` includes `"identify"`; `targetFieldsFor("bascule-nicad")` returns `BASCULE_NICAD_TARGET_FIELDS`.

- [ ] **Step 1: Extend `JobPhase` and `JobKind` in `src/lib/import/jobs.ts`**

Change line 9 from:
```ts
export type JobPhase = "read" | "build" | "nicad" | "analyze" | "sections" | "import" | "done";
```
to:
```ts
export type JobPhase = "read" | "build" | "nicad" | "analyze" | "sections" | "import" | "identify" | "done";
```

Change line 18 from:
```ts
export type JobKind = "parcelles" | "sections" | "cad-parcelles" | "cad-sections";
```
to:
```ts
export type JobKind = "parcelles" | "sections" | "cad-parcelles" | "cad-sections" | "bascule-nicad";
```

Update the doc comment directly above `JobKind` (lines 10-17) to add a third bullet:
```ts
/**
 * Cible du job :
 *  - "parcelles"/"sections" : pipeline DXF existant (Analysis / limite_section),
 *    aussi réutilisé pour le job shapefile de `SectionsClient` (kind "sections",
 *    sourceType "SHP" → même table limite_section, même report shape).
 *  - "cad-parcelles"/"cad-sections" : import shapefile en masse de
 *    `/cadastre/import` (écrit dans CadParcelle / CadSection).
 *  - "bascule-nicad" : identification en masse (SANS écriture) des cibles
 *    2026 pour une liste de NICAD 2013 fournie par shapefile — voir
 *    run-bascule-job.ts. Le basculement réel est un acte séparé, déclenché
 *    par l'utilisateur après revue du rapport (`executerBasculementListe`).
 */
```

- [ ] **Step 2: Add `BASCULE_NICAD_TARGET_FIELDS` to `src/lib/import/field-mapping.ts`**

Change line 11 from:
```ts
export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite" | "parcelles-home";
```
to:
```ts
export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite" | "parcelles-home" | "bascule-nicad";
```

Add this new exported constant right after `PARCELLES_HOME_TARGET_FIELDS` (after line 74):
```ts
/**
 * Cible de mappage pour l'import "Migration en masse" par shapefile
 * (job.kind === "bascule-nicad") : un seul champ requis, le NICAD 2013 à
 * identifier — mêmes alias que PARCELLES_HOME_TARGET_FIELDS pour rester
 * cohérent avec le devinage déjà en place ailleurs.
 */
export const BASCULE_NICAD_TARGET_FIELDS: TargetFieldDef[] = [
  {
    key: "nicad",
    label: "NICAD (16 caractères)",
    aliases: ["nicad", "nic", "num_nicad", "code_nicad", "codif"],
    required: true,
  },
];
```

Change `targetFieldsFor` (currently lines 93-98) from:
```ts
export function targetFieldsFor(target: ShapefileTarget): TargetFieldDef[] {
  if (target === "cad-parcelles") return PARCELLE_TARGET_FIELDS;
  if (target === "cad-sections") return CAD_SECTION_TARGET_FIELDS;
  if (target === "parcelles-home") return PARCELLES_HOME_TARGET_FIELDS;
  return LIMITE_SECTION_TARGET_FIELDS;
}
```
to:
```ts
export function targetFieldsFor(target: ShapefileTarget): TargetFieldDef[] {
  if (target === "cad-parcelles") return PARCELLE_TARGET_FIELDS;
  if (target === "cad-sections") return CAD_SECTION_TARGET_FIELDS;
  if (target === "parcelles-home") return PARCELLES_HOME_TARGET_FIELDS;
  if (target === "bascule-nicad") return BASCULE_NICAD_TARGET_FIELDS;
  return LIMITE_SECTION_TARGET_FIELDS;
}
```

- [ ] **Step 3: Allow `"bascule-nicad"` as an inventory target**

In `src/app/api/cadastre/import/inventory/route.ts`, change line 12 from:
```ts
const VALID_TARGETS: ShapefileTarget[] = ["cad-parcelles", "cad-sections", "sections-limite", "parcelles-home"];
```
to:
```ts
const VALID_TARGETS: ShapefileTarget[] = ["cad-parcelles", "cad-sections", "sections-limite", "parcelles-home", "bascule-nicad"];
```

- [ ] **Step 4: Allow `"bascule-nicad"` as a job kind in `POST /api/import-jobs`**

In `src/app/api/import-jobs/route.ts`, change the `shapefileTargetForKind` function (currently lines 33-38) from:
```ts
function shapefileTargetForKind(kind: string | undefined): ShapefileTarget {
  if (kind === "cad-sections") return "cad-sections";
  if (kind === "sections") return "sections-limite";
  if (kind === "parcelles") return "parcelles-home";
  return "cad-parcelles";
}
```
to:
```ts
function shapefileTargetForKind(kind: string | undefined): ShapefileTarget {
  if (kind === "cad-sections") return "cad-sections";
  if (kind === "sections") return "sections-limite";
  if (kind === "parcelles") return "parcelles-home";
  if (kind === "bascule-nicad") return "bascule-nicad";
  return "cad-parcelles";
}
```

Change the kind allow-list (currently around line 117) from:
```ts
        if (!body.kind || !["cad-parcelles", "cad-sections", "sections", "parcelles"].includes(body.kind)) {
          return NextResponse.json(
            { error: "kind requis pour un job shapefile (cad-parcelles|cad-sections|sections|parcelles)." },
            { status: 400 },
          );
        }
```
to:
```ts
        if (!body.kind || !["cad-parcelles", "cad-sections", "sections", "parcelles", "bascule-nicad"].includes(body.kind)) {
          return NextResponse.json(
            { error: "kind requis pour un job shapefile (cad-parcelles|cad-sections|sections|parcelles|bascule-nicad)." },
            { status: 400 },
          );
        }
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/lib/import/jobs.ts src/lib/import/field-mapping.ts src/app/api/cadastre/import/inventory/route.ts src/app/api/import-jobs/route.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/jobs.ts src/lib/import/field-mapping.ts src/app/api/cadastre/import/inventory/route.ts src/app/api/import-jobs/route.ts
git commit -m "feat(cadastre): ajouter le kind de job bascule-nicad (plomberie)

Etend JobKind/JobPhase/ShapefileTarget pour le futur job d'identification
en masse par shapefile (spec migration-masse-shapefile-design.md). Aucune
migration Prisma necessaire (kind/phase sont des String en base).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `run-bascule-job.ts` — job d'identification en masse

**Files:**
- Modify: `src/lib/import/run-shapefile-job.ts` (export `loadShapefilePair`, add dispatch case)
- Create: `src/lib/import/run-bascule-job.ts`

**Interfaces:**
- Consumes: `identifierBasculementNicad` (Task 1), `JobKind`/`JobPhase` (Task 2), `loadShapefilePair` (exported this task).
- Produces (used by Task 5): `job.report` shape when `job.kind === "bascule-nicad"` and `job.status === "completed"`:
  ```ts
  interface BasculeNicadItem {
    nicadAncien: string;
    dejaAJour: boolean;
    clean: boolean;
    flags: string[];
    proposition: { syscolNouveau: string; sectionNouvelle?: string } | null;
    commune2013?: string;
    commune2026?: string;
  }
  interface BasculeNicadReport {
    kind: "bascule-nicad";
    items: BasculeNicadItem[];
    stats: { total: number; invalides: number; dejaAJour: number; clean: number; avecDrapeaux: number };
  }
  ```

- [ ] **Step 1: Export `loadShapefilePair` from `run-shapefile-job.ts`**

In `src/lib/import/run-shapefile-job.ts`, change:
```ts
async function loadShapefilePair(fileKey: string): Promise<{ shpBuf: Buffer; dbfBuf: Buffer; prjBuf?: Buffer }> {
```
to:
```ts
export async function loadShapefilePair(fileKey: string): Promise<{ shpBuf: Buffer; dbfBuf: Buffer; prjBuf?: Buffer }> {
```

- [ ] **Step 2: Create `src/lib/import/run-bascule-job.ts`**

```ts
/**
 * run-bascule-job.ts — exécution asynchrone du job d'identification en masse
 * pour "Migration en masse" (`job.kind === "bascule-nicad"`, dispatché depuis
 * run-shapefile-job.ts). Lit un shapefile portant une colonne NICAD (2013),
 * et pour chaque NICAD valide, retrouve sa cible 2026 (commune + section, cas
 * simple ET complexe) via la même logique que la page "Basculement" —
 * `identifierBasculementNicad` (lib/cadastre/basculement.ts).
 *
 * AUCUNE écriture en base ici : ce job produit uniquement un rapport de
 * prévisualisation (`job.report`). Le basculement réel est un acte séparé,
 * déclenché par l'utilisateur après revue — `executerBasculementListe`
 * (`_actions/migration.ts`).
 */
import * as shapefile from "shapefile";
import { prisma } from "@/lib/prisma";
import { identifierBasculementNicad } from "@/lib/cadastre/basculement";
import { validateNicadFormat } from "@/lib/cadastre/nicad-logic";
import type { FieldMapping } from "./field-mapping";
import { loadShapefilePair } from "./run-shapefile-job";
import { getImportJob, setJobPhase, assertNotCancelled, markJobFailed, JobCancelledError } from "./jobs";

interface BasculeNicadItem {
  nicadAncien: string;
  dejaAJour: boolean;
  clean: boolean;
  flags: string[];
  proposition: { syscolNouveau: string; sectionNouvelle?: string } | null;
  commune2013?: string;
  commune2026?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(props: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = props?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export async function runBasculeNicadJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run-bascule] job ${jobId} introuvable`);
    return;
  }

  try {
    await setJobPhase(jobId, "read", 5, "running");
    const { shpBuf, dbfBuf } = await loadShapefilePair(job.fileKey);
    const fieldMapping = (job.layerMapping as FieldMapping | null) ?? undefined;

    const source = await shapefile.read(shpBuf, dbfBuf);
    const features = (source.features ?? []) as GeoJSON.Feature[];

    // Extraction + dédoublonnage + validation de format AVANT toute
    // identification — un shapefile réel peut répéter le même NICAD sur
    // plusieurs features (multi-parties), et contenir des colonnes vides
    // ou mal formées (saisie manuelle en amont).
    const seen = new Set<string>();
    const nicadsValides: string[] = [];
    let nbInvalides = 0;
    for (const f of features) {
      const props = f.properties ?? {};
      const raw = fieldMapping?.nicad
        ? pick(props, fieldMapping.nicad)
        : pick(props, "nicad", "nic", "num_nicad", "code_nicad", "codif");
      if (!raw) {
        nbInvalides++;
        continue;
      }
      const digits = raw.replace(/\D/g, "");
      if (digits.length !== 16 || !validateNicadFormat(digits).valid) {
        nbInvalides++;
        continue;
      }
      if (seen.has(digits)) continue;
      seen.add(digits);
      nicadsValides.push(digits);
    }

    await assertNotCancelled(jobId);
    await setJobPhase(jobId, "identify", 10);

    const items: BasculeNicadItem[] = [];
    let nbDejaAJour = 0;
    let nbClean = 0;
    let nbAvecDrapeaux = 0;

    for (let i = 0; i < nicadsValides.length; i++) {
      const nicadAncien = nicadsValides[i];
      const res = await identifierBasculementNicad(nicadAncien);

      if (!res.success) {
        items.push({
          nicadAncien,
          dejaAJour: false,
          clean: false,
          flags: [res.error ?? "Identification échouée."],
          proposition: null,
        });
        nbAvecDrapeaux++;
      } else if (res.dejaAJour) {
        items.push({
          nicadAncien,
          dejaAJour: true,
          clean: false,
          flags: res.flags,
          proposition: null,
          commune2026: res.commune2026?.nomCommune,
        });
        nbDejaAJour++;
      } else {
        const clean = !!res.clean;
        items.push({
          nicadAncien,
          dejaAJour: false,
          clean,
          flags: res.flags,
          proposition: res.proposition ?? null,
          commune2013: res.commune2013?.nomCommune ?? undefined,
          commune2026: res.commune2026?.nomCommune ?? undefined,
        });
        if (clean) nbClean++;
        else nbAvecDrapeaux++;
      }

      // Points de contrôle toutes les 20 identifications : suffisamment
      // fréquent pour que la barre de progression bouge visiblement (cf.
      // leçon du §58 CONCEPTS-TRAITEMENT-DXF.md — un job qui reste figé sur
      // la même valeur est indiscernable d'un blocage), sans réécrire la
      // ligne en base à chaque itération individuelle.
      if (i % 20 === 0 || i === nicadsValides.length - 1) {
        await assertNotCancelled(jobId);
        const pct = 10 + Math.round(((i + 1) / Math.max(nicadsValides.length, 1)) * 85);
        await setJobPhase(jobId, "identify", Math.min(pct, 95));
      }
    }

    await prisma.importJob.updateMany({
      where: { id: jobId, status: { not: "cancelled" } },
      data: {
        status: "completed",
        phase: "done",
        progress: 100,
        totalBuilt: items.length,
        report: {
          kind: "bascule-nicad",
          items,
          stats: {
            total: features.length,
            invalides: nbInvalides,
            dejaAJour: nbDejaAJour,
            clean: nbClean,
            avecDrapeaux: nbAvecDrapeaux,
          },
        },
      },
    });
  } catch (err) {
    if (err instanceof JobCancelledError) {
      console.log(`[import/run-bascule] ${err.message}`);
      return;
    }
    console.error(`[import/run-bascule] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 3: Dispatch to the new runner from `run-shapefile-job.ts`**

In `src/lib/import/run-shapefile-job.ts`, add the import:
```ts
import { runBasculeNicadJob } from "./run-bascule-job";
```

Add this branch at the top of `runShapefileImportJob`, right after `let opId: number | null = null;` and before the `try {` block starts its file-reading logic — actually, since `runBasculeNicadJob` does its OWN file reading (it calls `loadShapefilePair` itself), dispatch to it BEFORE the existing `try` block reads the shapefile pair, to avoid reading the file twice. Insert this immediately after the `if (!job) { ... return; }` guard at the top of `runShapefileImportJob`:
```ts
  if (job.kind === "bascule-nicad") {
    return runBasculeNicadJob(jobId);
  }
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/lib/import/run-bascule-job.ts src/lib/import/run-shapefile-job.ts`
Expected: no output.

- [ ] **Step 5: Manually verify the job runs end-to-end against the real dev database**

Build a tiny 1-feature test shapefile with a known 2013 NICAD (reuse the query from Task 1 Step 4 to find one), or write a throwaway script that inserts a job row directly and calls the runner:

```bash
npx tsx -e "
import { prisma } from './src/lib/prisma';
import { runBasculeNicadJob } from './src/lib/import/run-bascule-job';

async function main() {
  const nicadRow = await prisma.cadNicad.findFirst({ where: { version: '2013', statut: 'actif' } });
  if (!nicadRow) { console.log('Aucun NICAD 2013 en base pour tester.'); return; }
  console.log('NICAD de test:', nicadRow.nicad);

  // Fabrique un shapefile minimal en mémoire n'est pas trivial en une ligne —
  // à la place, on vérifie directement identifierBasculementNicad (le coeur
  // du job) contre ce NICAD réel :
  const { identifierBasculementNicad } = await import('./src/lib/cadastre/basculement');
  const res = await identifierBasculementNicad(nicadRow.nicad);
  console.log(JSON.stringify(res, null, 2));
  await prisma.\$disconnect();
}
main();
"
```

Expected: a JSON result with either `dejaAJour: true`, or `success: true` with a `proposition` and a `flags` array (empty if `clean`). This confirms `identifierBasculementNicad` (the piece `run-bascule-job.ts` calls in a loop) produces sane output against real data — the full job wiring (shapefile parsing, phase updates) is exercised end-to-end in Task 5's manual verification once the upload UI exists.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/run-bascule-job.ts src/lib/import/run-shapefile-job.ts
git commit -m "feat(cadastre): job d'identification en masse bascule-nicad

Lit un shapefile porteur d'une colonne NICAD, identifie la cible 2026 de
chacun (meme logique que la page Basculement, simple ET complexe) et
stocke le rapport dans job.report -- aucune ecriture en base a ce stade,
le basculement reel reste un acte separe approuve par l'utilisateur.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `executerBasculementListe` — exécution du basculement approuvé

**Files:**
- Modify: `src/app/cadastre/_actions/migration.ts`

**Interfaces:**
- Consumes: `basculerNicadCore` (Task 1).
- Produces (used by Task 5):
  ```ts
  export async function executerBasculementListe(input: {
    items: Array<{ nicadAncien: string; syscolNouveau: string; sectionNouvelle?: string }>;
  }): Promise<{
    success: true;
    nbMigres: number;
    nbEchecs: number;
    resultats: Array<{ nicadAncien: string; success: boolean; nicadNouveau?: string; error?: string }>;
  }>
  ```

- [ ] **Step 1: Add the action**

Add this import to the top of `src/app/cadastre/_actions/migration.ts`:
```ts
import { basculerNicadCore } from "@/lib/cadastre/basculement";
```

Add this function at the end of the file:
```ts
const executerBasculementListeSchema = z.object({
  items: z
    .array(
      z.object({
        nicadAncien: z.string().length(16),
        syscolNouveau: z.string().min(7).max(8),
        sectionNouvelle: z.string().min(1).max(3).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

export async function executerBasculementListe(input: z.infer<typeof executerBasculementListeSchema>) {
  const userId = await requireAdmin();
  const data = executerBasculementListeSchema.parse(input);

  const opId = await insertOperation({
    typeOperation: "basculement",
    statut: "en_cours",
    description: `Migration en masse par shapefile : ${data.items.length} NICAD`,
    createdBy: userId,
  });

  const resultats: Array<{ nicadAncien: string; success: boolean; nicadNouveau?: string; error?: string }> = [];
  let nbMigres = 0;
  let nbEchecs = 0;

  for (const item of data.items) {
    try {
      const res = await basculerNicadCore({
        nicadAncien: item.nicadAncien,
        syscolNouveau: item.syscolNouveau,
        sectionNouvelle: item.sectionNouvelle,
        motif: "Migration en masse par import shapefile",
        userId,
      });
      if (res.success) {
        resultats.push({ nicadAncien: item.nicadAncien, success: true, nicadNouveau: res.nicadNouveau });
        nbMigres++;
      } else {
        resultats.push({ nicadAncien: item.nicadAncien, success: false, error: res.error });
        nbEchecs++;
      }
    } catch (err) {
      resultats.push({
        nicadAncien: item.nicadAncien,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      nbEchecs++;
    }
  }

  await updateOperation(opId, {
    statut: nbEchecs === 0 ? "succes" : "echec",
    nbTraites: nbMigres + nbEchecs,
    nbSucces: nbMigres,
    nbEchecs,
  });

  return { success: true as const, nbMigres, nbEchecs, resultats };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/app/cadastre/_actions/migration.ts`
Expected: no output.

- [ ] **Step 3: Manually verify against the real dev database**

```bash
npx tsx -e "
import { prisma } from './src/lib/prisma';

async function main() {
  const nicadRow = await prisma.cadNicad.findFirst({ where: { version: '2013', statut: 'actif' } });
  if (!nicadRow) { console.log('Aucun NICAD 2013 en base pour tester.'); return; }
  const { identifierBasculementNicad } = await import('./src/lib/cadastre/basculement');
  const identification = await identifierBasculementNicad(nicadRow.nicad);
  if (!identification.success || identification.dejaAJour || !identification.proposition) {
    console.log('Ce NICAD ne convient pas pour ce test (pas de proposition claire) :', identification);
    return;
  }
  const { basculerNicadCore } = await import('./src/lib/cadastre/basculement');
  const res = await basculerNicadCore({
    nicadAncien: nicadRow.nicad,
    syscolNouveau: identification.proposition.syscolNouveau,
    sectionNouvelle: identification.proposition.sectionNouvelle,
    motif: 'Test manuel Task 4',
    userId: 'test-script',
  });
  console.log(JSON.stringify(res, null, 2));

  const updated = await prisma.cadNicad.findUnique({ where: { nicad: nicadRow.nicad } });
  console.log('Statut NICAD ancien après bascule :', updated?.statut);
  await prisma.\$disconnect();
}
main();
"
```

Expected: `res.success === true`, a `nicadNouveau` printed, and the old NICAD's `statut` now `"bascule"` in the DB. This confirms `basculerNicadCore` (the piece `executerBasculementListe` calls in a loop) writes correctly — the full action (auth guard, loop over multiple items, `Operation` record) is exercised end-to-end in Task 5's manual verification once the UI exists.

- [ ] **Step 4: Commit**

```bash
git add src/app/cadastre/_actions/migration.ts
git commit -m "feat(cadastre): action executerBasculementListe pour la migration en masse par shapefile

Applique basculerNicadCore en boucle sur les lignes approuvees par
l'utilisateur (issues du rapport de identification bascule-nicad),
capture les echecs par ligne sans interrompre les suivantes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: UI — upload + prévisualisation sur `/cadastre/migration`

**Files:**
- Modify: `src/app/cadastre/migration/page.tsx`

**Interfaces:**
- Consumes: `executerBasculementListe` (Task 4), `POST /api/cadastre/import/inventory` with `target: "bascule-nicad"` (Task 2), `POST /api/import-jobs` with `kind: "bascule-nicad"` (Task 2), `GET /api/import-jobs/[id]` (existing, unchanged), `job.report` shape from Task 3, `FieldMappingModal` (existing component, same props as used in `SectionsClient.tsx`), `JobProgressSteps` (existing component).
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add state, upload handler, and job polling**

Change the existing `import { useEffect, useState, useTransition } from "react";` line at the top of `src/app/cadastre/migration/page.tsx` to also bring in `useRef` and the `ChangeEvent` type:
```ts
import { useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
```

Add these new imports alongside the existing ones:
```ts
import { Upload } from "lucide-react";
import FieldMappingModal from "@/components/FieldMappingModal";
import { JobProgressSteps, type JobProgressStep } from "@/components/import/JobProgressSteps";
import { executerBasculementListe } from "../_actions/migration";
```

Add this type near the top of the file, alongside `Preview`:
```ts
type BasculeItem = {
  nicadAncien: string;
  dejaAJour: boolean;
  clean: boolean;
  flags: string[];
  proposition: { syscolNouveau: string; sectionNouvelle?: string } | null;
  commune2013?: string;
  commune2026?: string;
};
type BasculeReport = {
  kind: "bascule-nicad";
  items: BasculeItem[];
  stats: { total: number; invalides: number; dejaAJour: number; clean: number; avecDrapeaux: number };
};

const BASCULE_JOB_STEPS: JobProgressStep[] = [
  { key: "read", label: "Lecture du fichier" },
  { key: "identify", label: "Identification des cibles 2026" },
];
```

Inside the `MigrationPage` component, add this state right after the existing `useState` declarations:
```ts
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingInventory, setPendingInventory] = useState<{
    fileKey: string;
    fileName: string;
    targetFields: { key: string; label: string; aliases: string[]; required?: boolean }[];
    fields: string[];
    proposedMapping: Record<string, string>;
  } | null>(null);
  const [basculeJob, setBasculeJob] = useState<{
    id: number;
    status: string;
    phase: string | null;
    progress: number;
    error?: string | null;
  } | null>(null);
  const [basculeReport, setBasculeReport] = useState<BasculeReport | null>(null);
  const [selectedForBascule, setSelectedForBascule] = useState<Set<string>>(new Set());
  const [executingBascule, setExecutingBascule] = useState(false);
```

Add these handlers inside the component, right after `migrerToutes`:
```ts
  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const shpFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith(".dbf"));
    if (!shpFile || !dbfFile) {
      toast.error("Sélectionnez le .shp ET son .dbf ensemble.");
      e.target.value = "";
      return;
    }
    setBasculeReport(null);
    setBasculeJob(null);
    const fd = new FormData();
    fd.append("target", "bascule-nicad");
    for (const f of Array.from(files)) fd.append("files", f);
    try {
      const res = await fetch("/api/cadastre/import/inventory", { method: "POST", body: fd });
      const inv = await res.json();
      if (!res.ok) throw new Error(inv.error || "Inventaire échoué");
      setPendingInventory(inv);
    } catch (err) {
      toast.error(String(err));
    } finally {
      e.target.value = "";
    }
  }

  async function startBasculeJob(mapping: Record<string, string>) {
    if (!pendingInventory) return;
    const inv = pendingInventory;
    setPendingInventory(null);
    try {
      const res = await fetch("/api/import-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: inv.fileKey,
          fileName: inv.fileName,
          sourceType: "SHP",
          kind: "bascule-nicad",
          layerMapping: mapping,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import échoué");
      setBasculeJob({ id: data.jobId, status: data.status, phase: "read", progress: 0 });
    } catch (err) {
      toast.error(String(err));
    }
  }

  useEffect(() => {
    if (!basculeJob || (basculeJob.status !== "pending" && basculeJob.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${basculeJob.id}`);
        const j = await res.json();
        setBasculeJob({ id: j.id, status: j.status, phase: j.phase, progress: j.progress, error: j.error });
        if (j.status === "completed") {
          setBasculeReport(j.report as BasculeReport);
        } else if (j.status === "failed") {
          toast.error(j.error || "Échec de l'identification.");
        }
      } catch {
        // Prochain tick réessaiera — pas d'action sur une erreur réseau isolée.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [basculeJob]);

  function toggleSelected(nicad: string) {
    setSelectedForBascule((prev) => {
      const next = new Set(prev);
      if (next.has(nicad)) next.delete(nicad);
      else next.add(nicad);
      return next;
    });
  }

  function selectAllClean() {
    if (!basculeReport) return;
    setSelectedForBascule(new Set(basculeReport.items.filter((i) => i.clean).map((i) => i.nicadAncien)));
  }

  function executerSelection() {
    if (!basculeReport || selectedForBascule.size === 0) return;
    const items = basculeReport.items
      .filter((i) => selectedForBascule.has(i.nicadAncien) && i.proposition)
      .map((i) => ({
        nicadAncien: i.nicadAncien,
        syscolNouveau: i.proposition!.syscolNouveau,
        sectionNouvelle: i.proposition!.sectionNouvelle,
      }));
    setExecutingBascule(true);
    startTransition(async () => {
      try {
        const res = await executerBasculementListe({ items });
        toast.success(`${res.nbMigres} basculé(s), ${res.nbEchecs} échec(s).`);
        setSelectedForBascule(new Set());
        setBasculeReport(null);
        setBasculeJob(null);
      } catch (err) {
        toast.error(String(err));
      } finally {
        setExecutingBascule(false);
      }
    });
  }
```

- [ ] **Step 2: Render the upload + progress + preview UI**

Add this JSX block right before the closing `</div>` of the component's returned markup (after the existing "Prévisualisation" `<Card>`):
```tsx
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Importer un shapefile (NICAD)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sélectionnez un shapefile (.shp + .dbf) portant une colonne NICAD
            2013 — la cible 2026 de chaque NICAD (commune, section, cas
            simple ou complexe) sera identifiée automatiquement avant tout
            basculement.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".shp,.dbf,.prj"
            onChange={handleFileSelected}
            className="hidden"
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!basculeJob && basculeJob.status !== "completed" && basculeJob.status !== "failed"}
            className="gap-2"
          >
            <Upload className="h-4 w-4" /> Choisir un shapefile
          </Button>

          {basculeJob && (basculeJob.status === "pending" || basculeJob.status === "running") && (
            <JobProgressSteps
              steps={BASCULE_JOB_STEPS}
              phase={basculeJob.phase}
              status={basculeJob.status as "pending" | "running"}
              progress={basculeJob.progress}
            />
          )}

          {basculeReport && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>{basculeReport.stats.total} ligne(s) lue(s)</span>
                <span>·</span>
                <span>{basculeReport.stats.clean} sans drapeau</span>
                <span>·</span>
                <span>{basculeReport.stats.avecDrapeaux} avec drapeau</span>
                <span>·</span>
                <span>{basculeReport.stats.dejaAJour} déjà à jour</span>
                <span>·</span>
                <span>{basculeReport.stats.invalides} invalide(s)</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={selectAllClean}>
                  Sélectionner les lignes sans drapeau
                </Button>
                <Button
                  size="sm"
                  onClick={executerSelection}
                  disabled={selectedForBascule.size === 0 || executingBascule}
                  className="gap-2"
                >
                  <Play className="h-4 w-4" />
                  {executingBascule ? "Basculement…" : `Basculer la sélection (${selectedForBascule.size})`}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr className="border-b border-border/50">
                      <th className="py-2 pr-3" />
                      <th className="py-2 pr-3">NICAD ancien</th>
                      <th className="py-2 pr-3">→ Cible 2026</th>
                      <th className="py-2 pr-3">Statut</th>
                      <th className="py-2 pr-3">Drapeaux</th>
                    </tr>
                  </thead>
                  <tbody>
                    {basculeReport.items.map((item) => (
                      <tr
                        key={item.nicadAncien}
                        className={`border-b border-border/30 ${item.dejaAJour ? "opacity-50" : ""}`}
                      >
                        <td className="py-2 pr-3">
                          {!item.dejaAJour && item.proposition && (
                            <input
                              type="checkbox"
                              checked={selectedForBascule.has(item.nicadAncien)}
                              onChange={() => toggleSelected(item.nicadAncien)}
                            />
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{item.nicadAncien}</td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {item.proposition
                            ? `${item.proposition.syscolNouveau}${item.proposition.sectionNouvelle ? " / section " + item.proposition.sectionNouvelle : ""}`
                            : "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {item.dejaAJour ? "Déjà 2026" : item.clean ? "Sans drapeau" : "Avec drapeau"}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {item.flags.length > 0 ? item.flags.join(" · ") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {pendingInventory && (
        <FieldMappingModal
          fileName={pendingInventory.fileName}
          targetFields={pendingInventory.targetFields}
          availableFields={pendingInventory.fields}
          proposedMapping={pendingInventory.proposedMapping}
          onCancel={() => setPendingInventory(null)}
          onConfirm={(mapping) => void startBasculeJob(mapping)}
        />
      )}
```

- [ ] **Step 3: Verify compilation**

Run: `npx next typegen && npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/app/cadastre/migration/page.tsx`
Expected: no output.

- [ ] **Step 4: Manual end-to-end verification (real browser, real dev database)**

This is the full test plan from the spec's "Tests" section. Prepare a small test shapefile first:

```bash
npx tsx -e "
import { prisma } from './src/lib/prisma';
async function main() {
  const dejaAJour = await prisma.cadNicad.findFirst({ where: { version: '2026' } });
  const simple = await prisma.cadNicad.findFirst({ where: { version: '2013', statut: 'actif' } });
  console.log('Deja 2026 (pour tester dejaAJour: true):', dejaAJour?.nicad);
  console.log('2013 actif (pour tester le cas simple/complexe selon correspondance):', simple?.nicad);
  await prisma.\$disconnect();
}
main();
"
```

Build a tiny shapefile (QGIS, or any GIS tool available) with a `nicad` text column containing: the `dejaAJour` NICAD found above, the `simple` NICAD found above, and one made-up 16-digit string that will fail format/lookup validation (e.g. `9999999999999999`) to exercise the "invalide" path. Save as `.shp`+`.dbf` (WGS84 or any CRS — geometry is never read by this pipeline).

1. Start the dev server (`npm run dev`), sign in as an **admin** user. This is required for step 7 below (`executerBasculementListe` calls `requireAdmin`) — the identification/preview steps (2-6) work for any authenticated user, matching `previewCommune`/`previewToutes`'s existing `requireUserId`-only gate on this same page; only the actual write (Task 4) is admin-gated, consistent with `executerCommune`/`executerToutes`.
2. Go to `/cadastre/migration`, click "Choisir un shapefile", select the `.shp` and `.dbf` together.
3. Confirm the `FieldMappingModal` appears with "NICAD" pre-mapped to the `nicad` column; click confirm.
4. Confirm `JobProgressSteps` shows "Lecture du fichier" then "Identification des cibles 2026" with the spinner moving between them (not stuck).
5. Once done, confirm the preview table shows 3 rows: one dimmed/`dejaAJour`, one with a proposition (clean or flagged, depending on that commune's real correspondance data), and the invalid one should NOT appear at all (it's excluded, counted in `stats.invalides` instead) — confirm the stats line shows `invalides: 1`.
6. Click "Sélectionner les lignes sans drapeau", confirm only `clean: true` rows get checked (not the flagged one, not the `dejaAJour` one).
7. Click "Basculer la sélection", confirm a success toast appears with a count.
8. Re-run the same shapefile import (repeat steps 2-4): confirm the just-migrated NICAD now shows as `dejaAJour: true` (its old Syscol is now recognized as 2026-current) — this is the regression check from the spec's Test step 5.

- [ ] **Step 5: Commit**

```bash
git add src/app/cadastre/migration/page.tsx
git commit -m "feat(cadastre): UI d'import shapefile pour la migration en masse

Upload + mappage de champ (NICAD) + suivi de progression + tableau de
previsualisation avant tout basculement, sur /cadastre/migration.
Verifie manuellement de bout en bout (voir plan, Task 5 Step 4).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md` (append new numbered section — check the current last number first, this plan was written when §58 was the latest)
- Modify: `docs/README.md` (append the new entry to the existing summary cell, same convention as every other entry in that table)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (terminal task).

- [ ] **Step 1: Find the current last section number**

Run: `grep -n "^## " docs/CONCEPTS-TRAITEMENT-DXF.md | tail -3`

Use `<N+1>` (the next integer) as the new section number below — do not assume it's still 59; other work may have landed additional sections since this plan was written.

- [ ] **Step 2: Append the new section to `docs/CONCEPTS-TRAITEMENT-DXF.md`**

Insert before the closing `---` / "En cas de divergence..." footer, following the exact same structure as every other entry (Problème métier / Cause technique / Solution / Pourquoi) :

```markdown
## <N+1>. Migration en masse par import shapefile (NICAD) : réutilisation de la logique de basculement individuel

**Problème métier** : « Migration en masse » (par commune, depuis la base)
ne gérait que le cas simple (section inchangée) — un NICAD dont la section
a été redécoupée entre 2013 et 2026 migrait vers un numéro de section
obsolète ou incorrect. Seule la page « Basculement » (un NICAD à la fois)
gérait correctement les deux cas, via résolution spatiale
(`findSectionSpatialMatches`).

**Cause technique** : `executerMigrationCommune` (`lib/cadastre/data.ts`)
réutilise `p.numSection` tel quel pour TOUTES les parcelles d'une commune,
sans jamais vérifier par jointure spatiale si la section a changé de
numéro — logique volontairement simplifiée pour un traitement par lot
rapide, mais incomplète face à un redécoupage réel.

**Solution** : nouveau chemin d'import shapefile (`job.kind ===
"bascule-nicad"`, `run-bascule-job.ts`) qui applique, pour chaque NICAD
extrait du fichier, EXACTEMENT la même identification que la page
Basculement (`identifierBasculementNicad`, extraite dans
`lib/cadastre/basculement.ts` pour être partagée sans duplication entre
les deux chemins). Le job ne fait AUCUNE écriture — il produit un rapport
de prévisualisation (`job.report`) affiché en tableau sur `/cadastre/migration`,
que l'utilisateur approuve ligne par ligne ou en bloc (uniquement les
lignes `clean: true`, jamais les lignes à drapeau automatiquement) avant
que `executerBasculementListe` n'applique le basculement réel
(`basculerNicadCore`, même fonction que la page interactive).

**Pourquoi (pièges inclus)** : la logique de résolution spatiale
(`identifierBasculementNicad`) vivait jusque-là dans un fichier `"use
server"` (`_actions/nicad.ts`), donc invocable uniquement comme Server
Action côté client — inutilisable telle quelle depuis un job d'arrière-plan
(`run-bascule-job.ts`, exécuté via `after()`, hors contexte de requête
utilisateur). Extraite dans `lib/cadastre/basculement.ts`, sans `"use
server"` ni dépendance à `requireUserId()`, elle reste identique
bit-à-bit à ce qu'utilise la page interactive (`_actions/nicad.ts` n'est
plus qu'un mince wrapper auth+validation) — tout futur correctif de cette
logique profite aux deux chemins sans risque de divergence. Piège évité
par construction (leçon du §58, correctif du même jour) : `run-bascule-job.ts`
émet `setJobPhase("identify", ...)` toutes les 20 identifications plutôt
qu'une seule fois en fin de job — sur un shapefile de plusieurs milliers de
NICAD, l'identification (plusieurs requêtes DB par NICAD, dont une
jointure spatiale) peut prendre assez longtemps pour paraître bloquée sans
ce retour de progression régulier.
```

- [ ] **Step 3: Append the entry to `docs/README.md`**

Find the long single-cell row for "Concepts de traitement — récupération & qualité des parcelles DXF" (search for `centres de services fiscaux branchés sur les sélecteurs UI` to find the end of the cell, immediately followed by `**import shapefile page d'accueil semblant bloqué sur le bureau autonome**`). Append, right after that last entry and before the closing `|`:

```
, **migration en masse par import shapefile NICAD** (§<N+1> — réutilise `identifierBasculementNicad`/`basculerNicadCore` (extraites de `_actions/nicad.ts` vers `lib/cadastre/basculement.ts`, partagées sans duplication) pour identifier en masse la cible 2026 de NICAD fournis par shapefile, cas simple ET complexe — contrairement à la migration par commune existante qui ne gérait que le cas simple ; aucune écriture avant validation utilisateur du tableau de prévisualisation)
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (docs changes shouldn't affect this, but confirms nothing else broke)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md docs/README.md
git commit -m "docs(cadastre): documenter la migration en masse par shapefile NICAD

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
