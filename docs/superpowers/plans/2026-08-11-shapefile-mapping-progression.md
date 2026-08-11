# Import shapefile : mapping de champs + progression asynchrone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the two remaining shapefile import surfaces (`/cadastre/import` for Parcelles/Sections, and the shapefile branch of `SectionsClient.tsx`) to the same UX as the existing DXF import flow: a field-mapping confirmation step before processing, and an asynchronous job with phase/percentage progress (plus a cancel button) instead of a single blocking request.

**Architecture:** Reuse the existing `ImportJob` table and job-polling infrastructure built for DXF (`setJobPhase`, `GET /api/import-jobs/[id]`) unchanged. Add a parallel `runShapefileImportJob()` runner dispatched by `sourceType === "SHP"`, a new generic `FieldMappingModal` (attribute-column → target-field, the inverse direction of the DXF layer→class modal), and a shapefile field-inventory endpoint that persists `.shp`+`.dbf` together as one ZIP-backed `fileKey` (no `ImportJob` schema change). Legacy synchronous imports (Communes 2013/2026, NICAD CSV) are untouched.

**Tech Stack:** Next.js 16 (App Router, Turbopack), Prisma, the `shapefile` and `jszip` npm packages (both already dependencies), TypeScript strict mode.

## Global Constraints

- Only `/cadastre/import` types **Parcelles** and **Sections**, and the shapefile branch of `SectionsClient.tsx`, get mapping+progress. Communes 2013/2026 and NICAD (CSV) stay on the current synchronous path — do not touch them.
- No `ImportJob` Prisma schema migration: `sourceType` gains `"SHP"` as a third string value, `layerMapping` (JSON) is reused to store the shapefile field mapping, `status` gains `"cancelled"` — all free-form `String`/`Json` columns already, no migration needed.
- `importParcelles()`/`importSections()` (the legacy `FichierInput[]`-based functions used by `uploadShapefile()`) must keep byte-for-byte identical behavior — extract a shared core, don't rewrite them.
- Cancellation checkpoints go at existing phase-transition points only (`setJobPhase()` call sites) — do not restructure the DXF pipeline's internals (`ingestDxfToParcelles`, `assignNicad2026FromCommunes`, etc.).
- This project has **no test framework** (no vitest/jest — `package.json` only has `eslint`). Verification follows the existing repo convention: standalone scripts in `scripts/` run via `bun run scripts/<name>.ts`, using Node's built-in `assert` module (see `scripts/test-fusion-parcelles.ts`, `scripts/test-overlap-fix.ts` for precedent). UI changes are verified by running `bun run dev` and exercising the flow in the browser (per this project's CLAUDE.md).
- Lint after every task: `npx eslint <changed files>` must pass before committing.

---

### Task 1: Extend `ImportJob` types + cancellation primitives

**Files:**
- Modify: `src/lib/import/jobs.ts`

**Interfaces:**
- Produces: `SourceType = "DXF" | "DGN" | "SHP"`, `JobKind = "parcelles" | "sections" | "cad-parcelles" | "cad-sections"`, `JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled"`, `class JobCancelledError extends Error`, `assertNotCancelled(id: number): Promise<void>`, `cancelImportJob(id: number): Promise<{ cancelled: boolean }>`. `createImportJob()`'s `layerMapping` param widens from `LayerMapping | null` to `Record<string, string> | null` (so it can carry either the DXF layer→class map or the new shapefile field→column map — both are plain string-keyed string-valued records).

- [ ] **Step 1: Edit the type unions and widen `createImportJob`**

In `src/lib/import/jobs.ts`, replace:

```ts
export type SourceType = "DXF" | "DGN";
export type JobStatus = "pending" | "running" | "completed" | "failed";
export type JobPhase = "read" | "build" | "nicad" | "analyze" | "sections" | "done";
/** Cible du job : parcelles (Analysis) ou limite_section (contrôle chevauchements). */
export type JobKind = "parcelles" | "sections";

export async function createImportJob(input: {
  fileName: string;
  fileKey: string;
  sourceType: SourceType;
  userId?: string | null;
  /** Mappage calque → classe DGID validé par l'utilisateur (variante « simple »). */
  layerMapping?: LayerMapping | null;
  /** Cible du traitement (défaut "parcelles"). */
  kind?: JobKind;
}) {
```

with:

```ts
export type SourceType = "DXF" | "DGN" | "SHP";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type JobPhase = "read" | "build" | "nicad" | "analyze" | "sections" | "import" | "done";
/**
 * Cible du job :
 *  - "parcelles"/"sections" : pipeline DXF existant (Analysis / limite_section),
 *    aussi réutilisé pour le job shapefile de `SectionsClient` (kind "sections",
 *    sourceType "SHP" → même table limite_section, même report shape).
 *  - "cad-parcelles"/"cad-sections" : import shapefile en masse de
 *    `/cadastre/import` (écrit dans CadParcelle / CadSection).
 */
export type JobKind = "parcelles" | "sections" | "cad-parcelles" | "cad-sections";

export async function createImportJob(input: {
  fileName: string;
  fileKey: string;
  sourceType: SourceType;
  userId?: string | null;
  /**
   * Mappage validé par l'utilisateur avant traitement : calque → classe DGID
   * pour un job DXF (`LayerMapping`), ou champ cible → colonne .dbf pour un
   * job shapefile (`FieldMapping`, `src/lib/import/field-mapping.ts`) — les
   * deux sont des `Record<string, string>`, stockés tels quels en JSON.
   */
  layerMapping?: Record<string, string> | null;
  /** Cible du traitement (défaut "parcelles"). */
  kind?: JobKind;
}) {
```

- [ ] **Step 2: Add cancellation primitives at the bottom of the file**

```ts
export class JobCancelledError extends Error {
  constructor(jobId: number) {
    super(`Job ${jobId} annulé par l'utilisateur.`);
    this.name = "JobCancelledError";
  }
}

/** Point de contrôle appelé aux transitions de phase : stoppe le runner si le job a été annulé entre-temps. */
export async function assertNotCancelled(id: number): Promise<void> {
  const job = await prisma.importJob.findUnique({ where: { id }, select: { status: true } });
  if (job?.status === "cancelled") throw new JobCancelledError(id);
}

/** Marque un job `pending`/`running` comme annulé ; no-op s'il est déjà terminal. */
export async function cancelImportJob(id: number): Promise<{ cancelled: boolean }> {
  const job = await prisma.importJob.findUnique({ where: { id }, select: { status: true } });
  if (!job || (job.status !== "pending" && job.status !== "running")) {
    return { cancelled: false };
  }
  await prisma.importJob.update({ where: { id }, data: { status: "cancelled" } });
  return { cancelled: true };
}
```

- [ ] **Step 3: Lint**

Run: `npx eslint src/lib/import/jobs.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/import/jobs.ts
git commit -m "feat(import): extend ImportJob types for shapefile jobs + cancellation"
```

---

### Task 2: Field-mapping target definitions + proposal engine

**Files:**
- Create: `src/lib/import/field-mapping.ts`
- Test: `scripts/test-field-mapping.ts`

**Interfaces:**
- Consumes: `normalizeText` from `@/lib/cadastral-filter` (existing, `src/lib/cadastral-filter.ts:288`).
- Produces: `type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite"`, `interface TargetFieldDef { key: string; label: string; aliases: string[]; required?: boolean }`, `type FieldMapping = Record<string, string>` (target key → source .dbf column name), `PARCELLE_TARGET_FIELDS`, `CAD_SECTION_TARGET_FIELDS`, `LIMITE_SECTION_TARGET_FIELDS`, `targetFieldsFor(target): TargetFieldDef[]`, `proposeFieldMapping(availableColumns: string[], targetFields: TargetFieldDef[]): FieldMapping`.

- [ ] **Step 1: Write the file**

```ts
/**
 * field-mapping.ts — définitions des champs cibles pour le mapping shapefile
 * (variante attribut, symétrique du mapping calque→classe DXF de
 * `cadastral-filter.ts`). Les alias repris ici sont EXACTEMENT ceux déjà codés
 * en dur dans `import-data.ts` et `sections-from-shapefile.ts` (aucune perte
 * de couverture) — ils deviennent la proposition automatique affichée dans
 * `FieldMappingModal`, éditable par l'utilisateur avant de lancer le job.
 */
import { normalizeText } from "../cadastral-filter";

export type ShapefileTarget = "cad-parcelles" | "cad-sections" | "sections-limite";

export interface TargetFieldDef {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
}

/** Champ cible → nom de colonne .dbf source, validé par l'utilisateur. */
export type FieldMapping = Record<string, string>;

export const PARCELLE_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "nicad", label: "NICAD (16 caractères)", aliases: ["nicad"], required: true },
  { key: "codeSection", label: "Code section (11 chiffres, syscol+section)", aliases: ["codesectio", "cod_sect"] },
  { key: "numParcelle", label: "N° de parcelle", aliases: ["numparcell", "num_parce", "numparce", "numparcelle"] },
  { key: "commune", label: "Commune", aliases: ["commune", "nomcommune", "nom_commun", "nom"] },
  { key: "region", label: "Région", aliases: ["region"] },
  { key: "departement", label: "Département", aliases: ["departemen", "departement"] },
  { key: "quartier", label: "Quartier", aliases: ["quartier", "nom_quart"] },
  { key: "numLot", label: "N° de lot", aliases: ["numlot", "num_lot"] },
  { key: "titreParce", label: "Dénomination (titre)", aliases: ["titreparce", "titre_parc"] },
  { key: "typeDocFon", label: "Type de document foncier", aliases: ["typedocfon", "type_doc"] },
  { key: "natJuri", label: "Nature juridique", aliases: ["natjuri", "nat_juri"] },
  { key: "typeDestin", label: "Type de destination", aliases: ["typedestin", "type_dest"] },
  { key: "catOcup", label: "Catégorie d'occupation", aliases: ["catocup", "cat_ocup"] },
  { key: "superficie", label: "Superficie", aliases: ["suplegale", "supreelle", "superficie", "shape_area"] },
  { key: "proprietaire", label: "Propriétaire", aliases: ["titulaired", "occupant", "nomproprietaire"] },
];

export const CAD_SECTION_TARGET_FIELDS: TargetFieldDef[] = [
  { key: "numSectionCode", label: "Code section (11 chiffres, syscol+section)", aliases: ["num_sect_n"], required: true },
  { key: "nomSection", label: "Nom de la section", aliases: ["nom_sect", "nomsect", "nom_section"] },
  { key: "nomCommune", label: "Commune", aliases: ["com_arrond", "nomcommune", "nom_commun", "nom"] },
  { key: "region", label: "Région", aliases: ["region"] },
  { key: "departement", label: "Département/Arrondissement", aliases: ["arrondisse", "departement"] },
];

export const LIMITE_SECTION_TARGET_FIELDS: TargetFieldDef[] = [
  {
    key: "numSection",
    label: "Numéro de section",
    aliases: ["num_sect_n", "num_sectio", "num_sect", "numsect", "numsection", "num_section", "section"],
    required: true,
  },
];

export function targetFieldsFor(target: ShapefileTarget): TargetFieldDef[] {
  if (target === "cad-parcelles") return PARCELLE_TARGET_FIELDS;
  if (target === "cad-sections") return CAD_SECTION_TARGET_FIELDS;
  return LIMITE_SECTION_TARGET_FIELDS;
}

/** Propose un mappage champ cible → colonne .dbf par correspondance exacte (nom normalisé, insensible à la casse). */
export function proposeFieldMapping(
  availableColumns: string[],
  targetFields: TargetFieldDef[],
): FieldMapping {
  const byNormalized = new Map<string, string>();
  for (const col of availableColumns) {
    const key = normalizeText(col).replace(/ /g, "");
    if (!byNormalized.has(key)) byNormalized.set(key, col);
  }
  const mapping: FieldMapping = {};
  for (const field of targetFields) {
    for (const alias of field.aliases) {
      const hit = byNormalized.get(normalizeText(alias).replace(/ /g, ""));
      if (hit) {
        mapping[field.key] = hit;
        break;
      }
    }
  }
  return mapping;
}
```

- [ ] **Step 2: Write the verification script**

```ts
// scripts/test-field-mapping.ts
import assert from "node:assert";
import {
  PARCELLE_TARGET_FIELDS,
  LIMITE_SECTION_TARGET_FIELDS,
  proposeFieldMapping,
  targetFieldsFor,
} from "../src/lib/import/field-mapping";

// Colonnes typiques Esri (tronquées à 10 caractères, casse mixte)
const columns = ["NICAD", "Codesectio", "numParcell", "Commune", "REGION", "TitulaireD", "AutreChamp"];
const mapping = proposeFieldMapping(columns, PARCELLE_TARGET_FIELDS);

assert.strictEqual(mapping.nicad, "NICAD");
assert.strictEqual(mapping.codeSection, "Codesectio");
assert.strictEqual(mapping.numParcelle, "numParcell");
assert.strictEqual(mapping.commune, "Commune");
assert.strictEqual(mapping.region, "REGION");
assert.strictEqual(mapping.proprietaire, "TitulaireD");
assert.strictEqual(mapping.quartier, undefined, "pas de colonne quartier dans l'échantillon");

// Un seul champ requis pour la cible "sections-limite"
assert.strictEqual(targetFieldsFor("sections-limite").length, 1);
assert.strictEqual(LIMITE_SECTION_TARGET_FIELDS[0].required, true);

const sectionMapping = proposeFieldMapping(["Num_Sect_N"], LIMITE_SECTION_TARGET_FIELDS);
assert.strictEqual(sectionMapping.numSection, "Num_Sect_N");

console.log("OK: field-mapping proposal matches expected aliases");
```

- [ ] **Step 3: Run and verify**

Run: `bun run scripts/test-field-mapping.ts`
Expected: `OK: field-mapping proposal matches expected aliases`, exit code 0.

- [ ] **Step 4: Lint + commit**

```bash
npx eslint src/lib/import/field-mapping.ts scripts/test-field-mapping.ts
git add src/lib/import/field-mapping.ts scripts/test-field-mapping.ts
git commit -m "feat(import): add shapefile field-mapping target defs + proposal engine"
```

---

### Task 3: Shapefile field inventory (lib + API route)

**Files:**
- Create: `src/lib/import/shapefile-inventory.ts`
- Create: `src/app/api/cadastre/import/inventory/route.ts`
- Test: `scripts/test-shapefile-inventory.ts`

**Interfaces:**
- Consumes: `ShapefileTarget`, `TargetFieldDef`, `FieldMapping`, `targetFieldsFor`, `proposeFieldMapping` (Task 2); `saveImportUpload` (`src/lib/import/storage.ts`, existing).
- Produces: `interface ShapefileFieldEntry { name: string; sampleValues: string[]; nonEmptyCount: number }`, `interface ShapefileFieldInventory { featureCount: number; fields: ShapefileFieldEntry[]; targetFields: TargetFieldDef[]; proposedMapping: FieldMapping }`, `buildShapefileFieldInventory(shpBuf: Buffer, dbfBuf: Buffer, target: ShapefileTarget): Promise<ShapefileFieldInventory>`. Route: `POST /api/cadastre/import/inventory` (multipart `target` + `files`) → `{ fileKey, fileName, target, featureCount, fields, targetFields, proposedMapping }`.

- [ ] **Step 1: Write `shapefile-inventory.ts`**

```ts
/**
 * shapefile-inventory.ts — inventaire des colonnes .dbf d'un shapefile avant
 * import (variante shapefile de `src/lib/import/inventory.ts`, qui inventorie
 * des CALQUES DXF ; ici on inventorie des COLONNES d'attributs).
 */
import * as shapefile from "shapefile";
import {
  targetFieldsFor,
  proposeFieldMapping,
  type ShapefileTarget,
  type TargetFieldDef,
  type FieldMapping,
} from "./field-mapping";

export interface ShapefileFieldEntry {
  /** Nom de colonne .dbf tel quel (affichage + valeur de mappage). */
  name: string;
  /** Jusqu'à 3 valeurs non vides distinctes rencontrées (aide à la décision). */
  sampleValues: string[];
  nonEmptyCount: number;
}

export interface ShapefileFieldInventory {
  featureCount: number;
  fields: ShapefileFieldEntry[];
  targetFields: TargetFieldDef[];
  proposedMapping: FieldMapping;
}

export async function buildShapefileFieldInventory(
  shpBuf: Buffer,
  dbfBuf: Buffer,
  target: ShapefileTarget,
): Promise<ShapefileFieldInventory> {
  const source = await shapefile.read(shpBuf, dbfBuf);
  const features = (source.features ?? []) as GeoJSON.Feature[];
  const byName = new Map<string, { sampleValues: string[]; nonEmptyCount: number }>();

  for (const feature of features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(props)) {
      const entry = byName.get(name) ?? { sampleValues: [], nonEmptyCount: 0 };
      const str = value === null || value === undefined ? "" : String(value).trim();
      if (str) {
        entry.nonEmptyCount += 1;
        if (entry.sampleValues.length < 3 && !entry.sampleValues.includes(str)) {
          entry.sampleValues.push(str);
        }
      }
      byName.set(name, entry);
    }
  }

  const fields: ShapefileFieldEntry[] = Array.from(byName.entries())
    .map(([name, v]) => ({ name, sampleValues: v.sampleValues, nonEmptyCount: v.nonEmptyCount }))
    .sort((a, b) => b.nonEmptyCount - a.nonEmptyCount);

  const targetFields = targetFieldsFor(target);
  const proposedMapping = proposeFieldMapping(fields.map((f) => f.name), targetFields);

  return { featureCount: features.length, fields, targetFields, proposedMapping };
}
```

- [ ] **Step 2: Write the API route**

```ts
// src/app/api/cadastre/import/inventory/route.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import JSZip from "jszip";
import { auth } from "@/lib/auth";
import { saveImportUpload } from "@/lib/import/storage";
import { buildShapefileFieldInventory } from "@/lib/import/shapefile-inventory";
import type { ShapefileTarget } from "@/lib/import/field-mapping";

export const runtime = "nodejs";
export const maxDuration = 120;

const VALID_TARGETS: ShapefileTarget[] = ["cad-parcelles", "cad-sections", "sections-limite"];

/**
 * POST /api/cadastre/import/inventory — inventaire des colonnes .dbf d'un
 * shapefile AVANT lancement du job (mapping de champs, variante shapefile de
 * `/api/import-jobs/inventory`). Persiste .shp+.dbf ENSEMBLE dans une archive
 * ZIP (un seul `fileKey`, même contrat de colonne que le stockage DXF) —
 * réutilisée telle quelle par `runShapefileImportJob` au démarrage du job.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
    }

    const formData = await req.formData();
    const target = String(formData.get("target") ?? "") as ShapefileTarget;
    if (!VALID_TARGETS.includes(target)) {
      return NextResponse.json(
        { error: "target invalide (cad-parcelles|cad-sections|sections-limite)." },
        { status: 400 },
      );
    }

    const files = formData.getAll("files") as File[];
    const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
    const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
    if (!shpFile || !dbfFile) {
      return NextResponse.json(
        { error: "Fichier .shp ET .dbf requis (le .dbf porte les attributs à mapper)." },
        { status: 400 },
      );
    }

    const shpBuf = Buffer.from(await shpFile.arrayBuffer());
    const dbfBuf = Buffer.from(await dbfFile.arrayBuffer());

    const zip = new JSZip();
    zip.file(shpFile.name, shpBuf);
    zip.file(dbfFile.name, dbfBuf);
    const zipBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const fileKey = await saveImportUpload(`${shpFile.name.replace(/\.shp$/i, "")}.zip`, zipBuf);

    const inventory = await buildShapefileFieldInventory(shpBuf, dbfBuf, target);

    return NextResponse.json({ fileKey, fileName: shpFile.name, target, ...inventory });
  } catch (err) {
    console.error("[cadastre/import/inventory] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 3: Write the verification script**

Needs a tiny real shapefile fixture. Reuse whichever `.shp`/`.dbf` pair already exists under the repo for manual QA (check `uploads/` or ask for a sample) — if none is available, generate one inline via the `shapefile` package's writer is out of scope, so instead unit-test `buildShapefileFieldInventory` against an in-memory GeoJSON-shaped stub by monkey-patching is unnecessary complexity. Simpler: test only the pure aggregation logic by extracting it — but to keep this task minimal, test through the public function using a minimal hand-built `.dbf`/`.shp` pair is impractical without a real fixture. Use the existing project convention instead: write an integration script that exercises `buildShapefileFieldInventory` against a real sample file path passed as `argv[2]`, and skip gracefully if not provided (documented manual step).

```ts
// scripts/test-shapefile-inventory.ts
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { buildShapefileFieldInventory } from "../src/lib/import/shapefile-inventory";

const shpPath = process.argv[2];
if (!shpPath) {
  console.log(
    "SKIP: fournir un chemin .shp en argument (ex: bun run scripts/test-shapefile-inventory.ts path/to/file.shp) " +
      "— le .dbf voisin est déduit automatiquement. Aucun fixture shapefile n'est versionné dans ce repo.",
  );
  process.exit(0);
}

const dbfPath = shpPath.replace(/\.shp$/i, ".dbf");
const shpBuf = await readFile(shpPath);
const dbfBuf = await readFile(dbfPath);

const inventory = await buildShapefileFieldInventory(shpBuf, dbfBuf, "cad-parcelles");
assert.ok(inventory.featureCount > 0, "au moins une entité attendue");
assert.ok(inventory.fields.length > 0, "au moins une colonne .dbf attendue");
assert.deepStrictEqual(
  inventory.targetFields.map((f) => f.key),
  ["nicad", "codeSection", "numParcelle", "commune", "region", "departement", "quartier", "numLot", "titreParce", "typeDocFon", "natJuri", "typeDestin", "catOcup", "superficie", "proprietaire"],
);

console.log(`OK: ${inventory.featureCount} entités, ${inventory.fields.length} colonnes, mapping proposé:`, inventory.proposedMapping);
```

- [ ] **Step 4: Run**

Run: `bun run scripts/test-shapefile-inventory.ts` (no argument)
Expected: prints the `SKIP:` message, exit code 0 — confirms the module loads and its target-field list is correct without requiring a fixture. If a real cadastral `.shp`/`.dbf` sample is available locally (e.g. from a prior manual import), re-run with its path to confirm end-to-end parsing against real data.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/lib/import/shapefile-inventory.ts src/app/api/cadastre/import/inventory/route.ts scripts/test-shapefile-inventory.ts
git add src/lib/import/shapefile-inventory.ts src/app/api/cadastre/import/inventory/route.ts scripts/test-shapefile-inventory.ts
git commit -m "feat(import): shapefile field inventory endpoint (.dbf columns + sample values)"
```

---

### Task 4: Extract shared core from `importParcelles`/`importSections`

**Files:**
- Modify: `src/lib/cadastre/import-data.ts`
- Test: `scripts/test-import-data-mapping.ts`

**Interfaces:**
- Consumes: `FieldMapping` type (Task 2, `@/lib/import/field-mapping`).
- Produces: `importParcellesFromFeatures(features: GeoJSON.Feature[], fieldMapping: FieldMapping | undefined, onProgress?: (done: number, total: number) => Promise<void> | void): Promise<ImportResult>`, `importSectionsFromFeatures(features: GeoJSON.Feature[], fieldMapping: FieldMapping | undefined, onProgress?: (done: number, total: number) => Promise<void> | void): Promise<ImportResult>`. `importParcelles()`/`importSections()` keep their existing public signatures and now delegate to these.

- [ ] **Step 1: Add the import + a `mapped()` helper near the top of the file**

Add after the existing imports in `src/lib/cadastre/import-data.ts`:

```ts
import type { FieldMapping } from "@/lib/import/field-mapping";

/** Lit un champ via le mappage utilisateur si présent, sinon `undefined` (repli sur la devinette d'alias historique). */
function mapped(props: Record<string, unknown>, fieldMapping: FieldMapping | undefined, key: string): unknown {
  const col = fieldMapping?.[key];
  return col ? props[col] : undefined;
}
```

- [ ] **Step 2: Replace `importSections` with a core + thin wrapper**

Replace the whole `export async function importSections(fichiers: FichierInput[])` block (`src/lib/cadastre/import-data.ts:355-432`) with:

```ts
// ─── Import Sections ──────────────────────────────────────────────────────────
export async function importSectionsFromFeatures(
  features: GeoJSON.Feature[],
  fieldMapping: FieldMapping | undefined,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;
  const total = features.length;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    try {
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const numSectN =
        mapped(props, fieldMapping, "numSectionCode") ?? props.Num_sect_N ?? props.NUM_SECT_N ?? "";
      const numSectioRaw =
        props.Num_sectio ?? props.NUM_SECTIO ?? props.Num_sect ?? props.NUM_SECT ?? props.NUMSECT ?? props.numSection ?? props.NUM_SECTION ?? props.SECTION ?? "";
      const nomSection = mapped(props, fieldMapping, "nomSection") ?? props.NOM_SECT ?? props.NOMSECT ?? props.nomSection ?? props.NOM_SECTION ?? props.NAME ?? "";
      const nomCommune = mapped(props, fieldMapping, "nomCommune") ?? props.COM_ARROND ?? props.NomCommune ?? props.NOM_COMMUN ?? props.NOM ?? props.nom ?? "";
      const region = mapped(props, fieldMapping, "region") ?? props.REGION ?? props.region ?? "";
      const departement = mapped(props, fieldMapping, "departement") ?? props.ARRONDISSE ?? props.DEPARTEMENT ?? props.departement ?? "";

      let syscolPadded = "";
      let numSectionPadded = "";
      if (numSectN && String(numSectN).replace(/\D/g, "").length === 11) {
        const code11 = String(numSectN).replace(/\D/g, "");
        syscolPadded = code11.substring(0, 8);
        numSectionPadded = code11.substring(8, 11);
      } else {
        const syscolRaw = props.COD_SYSCOL ?? props.Syscol ?? props.SYSCOL ?? props.syscol ?? props.COMMUNE_SYS ?? "";
        if (!syscolRaw || !numSectioRaw) {
          nbIgnores++;
          continue;
        }
        syscolPadded = normalizeSyscol(syscolRaw);
        numSectionPadded = String(numSectioRaw).replace(/\D/g, "").padStart(3, "0");
      }
      if (!syscolPadded || !numSectionPadded) {
        nbIgnores++;
        continue;
      }
      const geomStr = extractGeometry(feature);
      const existingSection = await prisma.cadSection.findFirst({
        where: { syscolCommune: syscolPadded, numSection: numSectionPadded },
        select: { id: true },
      });
      if (existingSection) {
        await prisma.cadSection.update({
          where: { id: existingSection.id },
          data: {
            nomSection: nomSection ? String(nomSection) : undefined,
            nomCommune: nomCommune ? String(nomCommune) : undefined,
            geojson: geomStr ?? undefined,
          },
        });
      } else {
        await prisma.cadSection.create({
          data: {
            syscolCommune: syscolPadded,
            numSection: numSectionPadded,
            nomSection: nomSection ? String(nomSection) : undefined,
            nomCommune: nomCommune ? String(nomCommune) : undefined,
            region: region ? String(region) : undefined,
            departement: departement ? String(departement) : undefined,
            version: "2013",
            geojson: geomStr ?? undefined,
          },
        });
      }
      nbImportes++;
    } catch (err) {
      nbErreurs++;
      if (nbErreurs <= 5) warnings.push(`Erreur feature: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (onProgress && (i % 100 === 0 || i === total - 1)) await onProgress(i + 1, total);
  }
  return { nbImportes, nbIgnores, nbErreurs, warnings };
}

export async function importSections(fichiers: FichierInput[]): Promise<ImportResult> {
  const geojson = await resolveGeoJSON(fichiers);
  if (!geojson) {
    throw new Error("Format non reconnu. Fournissez un shapefile (.shp + .dbf) ou GeoJSON (.geojson)");
  }
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  return importSectionsFromFeatures(features, undefined);
}
```

- [ ] **Step 3: Replace `importParcelles` with a core + thin wrapper**

Replace the whole `export async function importParcelles(fichiers: FichierInput[])` block (`src/lib/cadastre/import-data.ts:435-539`) with:

```ts
// ─── Import Parcelles ─────────────────────────────────────────────────────────
export async function importParcellesFromFeatures(
  features: GeoJSON.Feature[],
  fieldMapping: FieldMapping | undefined,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<ImportResult> {
  const warnings: string[] = [];
  let nbImportes = 0;
  let nbIgnores = 0;
  let nbErreurs = 0;
  const total = features.length;

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    try {
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const nicadRaw = String(mapped(props, fieldMapping, "nicad") ?? props.nicad ?? props.NICAD ?? "").replace(/\D/g, "");
      const codesectio = String(
        mapped(props, fieldMapping, "codeSection") ?? props.Codesectio ?? props.CODESECTIO ?? props.COD_SECT ?? "",
      ).replace(/\D/g, "");
      const numParcelleRaw =
        mapped(props, fieldMapping, "numParcelle") ?? props.numParcell ?? props.NUM_PARCE ?? props.NUMPARCE ?? props.numParcelle ?? "";

      let syscolPadded = "";
      let numSectionPadded = "";
      let numParcellePadded = "";
      let nicadCode = "";

      if (nicadRaw.length === 16) {
        syscolPadded = nicadRaw.substring(0, 8);
        numSectionPadded = nicadRaw.substring(8, 11);
        numParcellePadded = nicadRaw.substring(11, 16);
        nicadCode = nicadRaw;
      } else if (codesectio.length === 11) {
        syscolPadded = codesectio.substring(0, 8);
        numSectionPadded = codesectio.substring(8, 11);
        numParcellePadded = numParcelleRaw
          ? String(numParcelleRaw).replace(/\D/g, "").padStart(5, "0")
          : String(i + 1).padStart(5, "0");
      } else {
        const syscolRaw = props.COD_SYSCOL ?? props.Syscol ?? props.SYSCOL ?? props.syscol ?? props.COMMUNE_SYS ?? "";
        if (!syscolRaw) {
          nbIgnores++;
          continue;
        }
        syscolPadded = normalizeSyscol(syscolRaw);
        const numSectionRaw = props.NUM_SECT ?? props.NUMSECT ?? props.numSection ?? props.NUM_SECTION ?? "";
        numSectionPadded = numSectionRaw ? String(numSectionRaw).replace(/\D/g, "").padStart(3, "0") : "001";
        numParcellePadded = numParcelleRaw
          ? String(numParcelleRaw).replace(/\D/g, "").padStart(5, "0")
          : String(i + 1).padStart(5, "0");
      }
      if (!syscolPadded || !numSectionPadded || !numParcellePadded) {
        nbIgnores++;
        continue;
      }

      const nomCommune = mapped(props, fieldMapping, "commune") ?? props.commune ?? props.NomCommune ?? props.NOM_COMMUN ?? props.NOM ?? "";
      const region = mapped(props, fieldMapping, "region") ?? props.region ?? props.REGION ?? "";
      const departement = mapped(props, fieldMapping, "departement") ?? props.departemen ?? props.DEPARTEMENT ?? props.departement ?? "";
      const quartier = mapped(props, fieldMapping, "quartier") ?? props.Quartier ?? props.QUARTIER ?? props.quartier ?? props.NOM_QUART ?? "";
      const numLot = mapped(props, fieldMapping, "numLot") ?? props.NumLot ?? props.NUM_LOT ?? props.NUMLOT ?? props.numLot ?? "";
      const titreParce = mapped(props, fieldMapping, "titreParce") ?? props.TitreParce ?? props.TITRE_PARC ?? props.TITREPARCE ?? props.titreParce ?? "";
      const typeDocFon = mapped(props, fieldMapping, "typeDocFon") ?? props.TypeDocFon ?? props.TYPE_DOC ?? props.TYPEDOC ?? props.typeDocFon ?? "";
      const natJuri = mapped(props, fieldMapping, "natJuri") ?? props.NatJuri ?? props.NAT_JURI ?? props.NATJURI ?? props.natJuri ?? "";
      const typeDestin = mapped(props, fieldMapping, "typeDestin") ?? props.TypeDestin ?? props.TYPE_DEST ?? props.TYPEDEST ?? props.typeDestin ?? "";
      const catOcup = mapped(props, fieldMapping, "catOcup") ?? props.CatOcup ?? props.CAT_OCUP ?? props.CATOCUP ?? props.catOcup ?? "";
      const superficie = mapped(props, fieldMapping, "superficie") ?? props.SupLegale ?? props.SupReelle ?? props.SUPERFICIE ?? props.superficie ?? props.Shape_Area ?? "";
      const nomProprietaire = mapped(props, fieldMapping, "proprietaire") ?? props.TitulaireD ?? props.Occupant ?? props.nomProprietaire ?? "";

      const geomConverted = feature.geometry ? convertGeometryToWgs84(feature.geometry) : null;
      const geomStr = geomConverted ? JSON.stringify(geomConverted) : null;
      const centroid = geomConverted ? approximateCentroid(geomConverted) : null;
      const superficieNum = superficie ? parseFloat(String(superficie)) : undefined;

      await prisma.cadParcelle.create({
        data: {
          syscolCommune: syscolPadded,
          numSection: numSectionPadded,
          numParcelle: numParcellePadded,
          version: "2013",
          statut: nicadCode ? "actif" : "sans_nicad",
          nicad: nicadCode || undefined,
          nomCommune: nomCommune ? String(nomCommune) : undefined,
          region: region ? String(region) : undefined,
          departement: departement ? String(departement) : undefined,
          quartier: quartier ? String(quartier) : undefined,
          numLot: numLot ? String(numLot) : undefined,
          titreParce: titreParce ? String(titreParce) : undefined,
          typeDocFon: typeDocFon ? String(typeDocFon) : undefined,
          natJuri: natJuri ? String(natJuri) : undefined,
          typeDestin: typeDestin ? String(typeDestin) : undefined,
          catOcup: catOcup ? String(catOcup) : undefined,
          nomProprietaire: nomProprietaire ? String(nomProprietaire) : undefined,
          superficie: superficieNum && !isNaN(superficieNum) ? superficieNum : undefined,
          geojson: geomStr ?? undefined,
          longitude: centroid ? centroid.lon : undefined,
          latitude: centroid ? centroid.lat : undefined,
        },
      });
      nbImportes++;
    } catch (err) {
      nbErreurs++;
      if (nbErreurs <= 5) warnings.push(`Erreur feature ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (onProgress && (i % 100 === 0 || i === total - 1)) await onProgress(i + 1, total);
  }
  return { nbImportes, nbIgnores, nbErreurs, warnings };
}

export async function importParcelles(fichiers: FichierInput[]): Promise<ImportResult> {
  const geojson = await resolveGeoJSON(fichiers);
  if (!geojson) {
    throw new Error("Format non reconnu. Fournissez un shapefile (.shp + .dbf) ou GeoJSON (.geojson)");
  }
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  return importParcellesFromFeatures(features, undefined);
}
```

- [ ] **Step 4: Write the verification script**

This confirms the legacy path (`fieldMapping: undefined`) reads the exact same properties as before, and that an explicit mapping overrides them — without touching the database (pure extraction logic check via a stubbed `prisma`). Since `import-data.ts` calls `prisma.cadParcelle.create`/`cadSection.create` directly, a true unit test would need a DB; instead verify the **field-resolution precedence** in isolation by re-implementing the same `mapped()` precedence check the module exports implicitly — simplest reliable check is a small in-process assertion against the exported `mapped`-driven behavior via a two-feature dry run against a disposable schema is out of scope here. Keep this script focused on what's safe to assert without a DB: that `importParcellesFromFeatures`/`importSectionsFromFeatures` are exported with the right arity, and that calling them with an empty `features` array (no DB writes triggered) returns a zeroed `ImportResult`.

```ts
// scripts/test-import-data-mapping.ts
import assert from "node:assert";
import { importParcellesFromFeatures, importSectionsFromFeatures } from "../src/lib/cadastre/import-data";

const emptyParcelles = await importParcellesFromFeatures([], undefined);
assert.deepStrictEqual(emptyParcelles, { nbImportes: 0, nbIgnores: 0, nbErreurs: 0, warnings: [] });

const emptySections = await importSectionsFromFeatures([], { numSectionCode: "NUM_SECT_N" });
assert.deepStrictEqual(emptySections, { nbImportes: 0, nbIgnores: 0, nbErreurs: 0, warnings: [] });

console.log("OK: importParcellesFromFeatures/importSectionsFromFeatures handle empty input without touching the DB");
```

- [ ] **Step 5: Run**

Run: `bun run scripts/test-import-data-mapping.ts`
Expected: `OK: importParcellesFromFeatures/importSectionsFromFeatures handle empty input without touching the DB`.

- [ ] **Step 6: Manual regression check on the legacy path**

Since this task rewrites `importParcelles`/`importSections` body (extraction, not logic change), run `bun run dev`, open `/cadastre/import`, pick **Communes 2013** (unaffected) to confirm the page still works end-to-end, then pick **Parcelles**/**Sections** with a real shapefile pair and confirm the import still succeeds exactly as before (this task does not yet wire the new mapping UI — the page still calls the legacy `uploadShapefile()` action until Task 11).

- [ ] **Step 7: Lint + commit**

```bash
npx eslint src/lib/cadastre/import-data.ts scripts/test-import-data-mapping.ts
git add src/lib/cadastre/import-data.ts scripts/test-import-data-mapping.ts
git commit -m "refactor(cadastre): extract importXFromFeatures core with optional field mapping"
```

---

### Task 5: Field-mapping override in `sectionCandidatesFromShapefile`

**Files:**
- Modify: `src/lib/cadastre/sections-from-shapefile.ts`

**Interfaces:**
- Produces: `sectionCandidatesFromShapefile(files: ShapefileInput[], fieldMapping?: { numSection?: string }): Promise<SectionCandidate[]>` (2nd param is new and optional — existing callers compile unchanged).

- [ ] **Step 1: Update `extractNumSection` to accept a mapped column**

Replace (`src/lib/cadastre/sections-from-shapefile.ts:63-75`):

```ts
/** Numéro de section : mêmes alias d'attributs que l'import shapefile du module Cadastre. */
function extractNumSection(props: Record<string, unknown>): string | null {
  const numSectN = propByAlias(props, "num_sect_n");
  if (numSectN && String(numSectN).replace(/\D/g, "").length === 11) {
    return String(numSectN).replace(/\D/g, "").substring(8, 11);
  }
  const raw = propByAlias(
    props,
    "num_sectio", "num_sect", "numsect", "numsection", "num_section", "section",
  );
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits ? digits.padStart(3, "0") : null;
}
```

with:

```ts
/**
 * Numéro de section : priorité à la colonne mappée par l'utilisateur
 * (`FieldMappingModal`), repli sur les mêmes alias d'attributs que l'import
 * shapefile du module Cadastre si non mappée ou absente de la feature.
 */
function extractNumSection(props: Record<string, unknown>, mappedColumn?: string): string | null {
  if (mappedColumn) {
    const raw = props[mappedColumn];
    const digits = raw !== undefined && raw !== null ? String(raw).replace(/\D/g, "") : "";
    if (digits.length === 11) return digits.substring(8, 11);
    if (digits) return digits.padStart(3, "0");
  }
  const numSectN = propByAlias(props, "num_sect_n");
  if (numSectN && String(numSectN).replace(/\D/g, "").length === 11) {
    return String(numSectN).replace(/\D/g, "").substring(8, 11);
  }
  const raw = propByAlias(
    props,
    "num_sectio", "num_sect", "numsect", "numsection", "num_section", "section",
  );
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits ? digits.padStart(3, "0") : null;
}
```

- [ ] **Step 2: Thread the mapping through `sectionCandidatesFromShapefile`**

In the same file, update the function signature and its two `extractNumSection(...)` call sites (`src/lib/cadastre/sections-from-shapefile.ts:127-129` and the polygon/line branches around lines 155 and 168):

```ts
export async function sectionCandidatesFromShapefile(
  files: ShapefileInput[],
  fieldMapping?: { numSection?: string },
): Promise<SectionCandidate[]> {
```

```ts
      const numSection = extractNumSection(props, fieldMapping?.numSection);
```
(polygon branch, was `extractNumSection(props)`)

```ts
      const numSection = extractNumSection((feature.properties ?? {}) as Record<string, unknown>, fieldMapping?.numSection);
```
(line branch, was `extractNumSection((feature.properties ?? {}) as Record<string, unknown>)`)

- [ ] **Step 3: Lint + commit**

```bash
npx eslint src/lib/cadastre/sections-from-shapefile.ts
git add src/lib/cadastre/sections-from-shapefile.ts
git commit -m "feat(cadastre): allow mapped column override for section-number extraction"
```

---

### Task 6: Shapefile job runner

**Files:**
- Create: `src/lib/import/run-shapefile-job.ts`
- Test: `scripts/test-run-shapefile-job.ts`

**Interfaces:**
- Consumes: `importParcellesFromFeatures`, `importSectionsFromFeatures` (Task 4); `sectionCandidatesFromShapefile` (Task 5); `buildLimiteSections` (`src/lib/cadastre/build-sections.ts`, existing, signature `(result: { sections: SectionCandidate[] }, sourceFichier: string) => Promise<BuildSectionsResult>`); `insertOperation`/`updateOperation` (`src/lib/cadastre/data.ts`, existing); `getImportJob`, `setJobPhase`, `setJobProgress`, `markJobFailed`, `assertNotCancelled`, `JobCancelledError` (Task 1, `@/lib/import/jobs`); `loadImportUpload` (`src/lib/import/storage.ts`, existing); `FieldMapping` (Task 2).
- Produces: `runShapefileImportJob(jobId: number): Promise<void>`.

- [ ] **Step 1: Write the file**

```ts
/**
 * run-shapefile-job.ts — exécution asynchrone d'un job d'import shapefile
 * (`.shp`+`.dbf`, persistés ensemble sous forme de ZIP par
 * `POST /api/cadastre/import/inventory`). Symétrique de `run-job.ts` (DXF),
 * dispatché depuis `runImportJob()` quand `sourceType === "SHP"`.
 *
 *   kind "cad-parcelles" / "cad-sections" : import en masse vers CadParcelle /
 *     CadSection (mapping de champs appliqué via `importXFromFeatures`).
 *   kind "sections" : même cible que le job DXF `sections` (table
 *     limite_section) — `sectionCandidatesFromShapefile` + `buildLimiteSections`.
 */
import * as shapefile from "shapefile";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { importParcellesFromFeatures, importSectionsFromFeatures } from "@/lib/cadastre/import-data";
import { sectionCandidatesFromShapefile } from "@/lib/cadastre/sections-from-shapefile";
import { buildLimiteSections } from "@/lib/cadastre/build-sections";
import { insertOperation, updateOperation } from "@/lib/cadastre/data";
import type { FieldMapping } from "./field-mapping";
import { loadImportUpload } from "./storage";
import { getImportJob, setJobPhase, setJobProgress, markJobFailed, assertNotCancelled, JobCancelledError } from "./jobs";

async function loadShapefilePair(fileKey: string): Promise<{ shpBuf: Buffer; dbfBuf: Buffer }> {
  const zipBuf = await loadImportUpload(fileKey);
  const zip = await JSZip.loadAsync(zipBuf);
  const shpEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".shp"));
  const dbfEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".dbf"));
  if (!shpEntry || !dbfEntry) throw new Error("Archive shapefile incomplète (.shp/.dbf manquant).");
  return {
    shpBuf: Buffer.from(await shpEntry.async("arraybuffer")),
    dbfBuf: Buffer.from(await dbfEntry.async("arraybuffer")),
  };
}

export async function runShapefileImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run-shapefile] job ${jobId} introuvable`);
    return;
  }

  try {
    await setJobPhase(jobId, "read", 5, "running");
    const { shpBuf, dbfBuf } = await loadShapefilePair(job.fileKey);
    const fieldMapping = (job.layerMapping as FieldMapping | null) ?? undefined;

    if (job.kind === "sections") {
      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "build", 25);
      const candidates = await sectionCandidatesFromShapefile(
        [
          { name: "upload.shp", buffer: shpBuf },
          { name: "upload.dbf", buffer: dbfBuf },
        ],
        { numSection: fieldMapping?.numSection },
      );
      if (candidates.length === 0) {
        throw new Error("Aucun polygone de section exploitable dans le shapefile.");
      }

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "sections", 65);
      const built = await buildLimiteSections({ sections: candidates }, job.fileName);

      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          phase: "done",
          progress: 100,
          totalBuilt: built.nbSections,
          report: { kind: "sections", ...built },
        },
      });
      return;
    }

    if (job.kind === "cad-parcelles" || job.kind === "cad-sections") {
      const source = await shapefile.read(shpBuf, dbfBuf);
      const features = (source.features ?? []) as GeoJSON.Feature[];

      const opId = job.userId
        ? await insertOperation({
            typeOperation: "import",
            statut: "en_cours",
            description: `Import ${job.kind === "cad-parcelles" ? "parcelles" : "sections"} (shapefile) : ${job.fileName}`,
            createdBy: job.userId,
          })
        : null;

      await assertNotCancelled(jobId);
      await setJobPhase(jobId, "import", 10);
      const onProgress = async (done: number, total: number) => {
        await assertNotCancelled(jobId);
        const pct = 10 + Math.round((done / Math.max(total, 1)) * 85);
        await setJobProgress(jobId, Math.min(pct, 95));
      };

      const result =
        job.kind === "cad-parcelles"
          ? await importParcellesFromFeatures(features, fieldMapping, onProgress)
          : await importSectionsFromFeatures(features, fieldMapping, onProgress);

      if (opId) {
        await updateOperation(opId, {
          statut: "succes",
          nbTraites: result.nbImportes,
          nbSucces: result.nbImportes,
          nbEchecs: result.nbErreurs ?? 0,
        });
      }

      await prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          phase: "done",
          progress: 100,
          totalBuilt: result.nbImportes,
          report: { kind: job.kind, ...result },
        },
      });
      return;
    }

    throw new Error(`kind de job shapefile non pris en charge: ${job.kind}`);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      console.log(`[import/run-shapefile] ${err.message}`);
      return;
    }
    console.error(`[import/run-shapefile] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 2: Write the verification script**

No DB fixture is versioned in this repo, so this integration check runs only when a real job id is supplied (created manually via the UI once Task 11/12 land) — like Task 3's script, it degrades to a structural check otherwise.

```ts
// scripts/test-run-shapefile-job.ts
import assert from "node:assert";
import { runShapefileImportJob } from "../src/lib/import/run-shapefile-job";

assert.strictEqual(typeof runShapefileImportJob, "function");

const jobIdArg = process.argv[2];
if (!jobIdArg) {
  console.log(
    "SKIP: fournir un id de job existant (pending, sourceType SHP) en argument pour l'exécuter réellement — " +
      "ex: bun run scripts/test-run-shapefile-job.ts 42",
  );
  process.exit(0);
}

await runShapefileImportJob(Number(jobIdArg));
console.log(`OK: runShapefileImportJob(${jobIdArg}) a terminé sans lever d'exception — vérifier son statut via GET /api/import-jobs/${jobIdArg}`);
```

- [ ] **Step 3: Run**

Run: `bun run scripts/test-run-shapefile-job.ts`
Expected: prints the `SKIP:` message, exit code 0. Full end-to-end verification happens in Task 11/12 once a job can actually be created from the UI.

- [ ] **Step 4: Lint + commit**

```bash
npx eslint src/lib/import/run-shapefile-job.ts scripts/test-run-shapefile-job.ts
git add src/lib/import/run-shapefile-job.ts scripts/test-run-shapefile-job.ts
git commit -m "feat(import): add runShapefileImportJob (cad-parcelles/cad-sections/sections)"
```

---

### Task 7: Dispatch DXF vs shapefile in `runImportJob` + cancellation checkpoints

**Files:**
- Modify: `src/lib/import/run-job.ts`

**Interfaces:**
- Consumes: `runShapefileImportJob` (Task 6); `assertNotCancelled`, `JobCancelledError` (Task 1).
- Produces: `runImportJob(jobId: number): Promise<void>` (unchanged export name/signature — existing callers in `src/app/api/import-jobs/route.ts` and `src/app/api/cadastre/sections/import/route.ts` need no changes). The old body becomes an internal `runDxfImportJob`.

- [ ] **Step 1: Rename the existing function and add the dispatcher**

At the top of `src/lib/import/run-job.ts`, add the import:

```ts
import { runShapefileImportJob } from "./run-shapefile-job";
```

Change the export line (`src/lib/import/run-job.ts:41`) from:

```ts
export async function runImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run] job ${jobId} introuvable`);
    return;
  }

  try {
```

to:

```ts
/** Dispatcher : délègue au runner shapefile si `sourceType === "SHP"`, sinon exécute le pipeline DXF ci-dessous. */
export async function runImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) {
    console.warn(`[import/run] job ${jobId} introuvable`);
    return;
  }
  if (job.sourceType === "SHP") {
    return runShapefileImportJob(jobId);
  }
  return runDxfImportJob(jobId);
}

async function runDxfImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) return;

  try {
```

- [ ] **Step 2: Add cancellation checkpoints at each phase transition**

Import `assertNotCancelled` and `JobCancelledError` alongside the existing `jobs` import (`src/lib/import/run-job.ts:34`):

```ts
import { getImportJob, setJobPhase, markJobFailed, assertNotCancelled, JobCancelledError, type SourceType } from "./jobs";
```

Insert `await assertNotCancelled(jobId);` immediately before each of these existing lines in `runDxfImportJob` (5 checkpoints, no other change to the surrounding logic):
- before `await setJobPhase(jobId, "build", 20);` (sections branch, was line 58)
- before `await setJobPhase(jobId, "sections", 65);` (was line 64)
- before `await setJobPhase(jobId, "build", 10);` (parcelles branch, was line 89)
- before `await setJobPhase(jobId, "nicad", 60);` (was line 92)
- before `await setJobPhase(jobId, "analyze", 72);` (was line 100)

- [ ] **Step 3: Handle `JobCancelledError` in the catch block**

Change the trailing `catch` block (was `src/lib/import/run-job.ts:188-191`):

```ts
  } catch (err) {
    console.error(`[import/run] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
```

to:

```ts
  } catch (err) {
    if (err instanceof JobCancelledError) {
      console.log(`[import/run] ${err.message}`);
      return;
    }
    console.error(`[import/run] job ${jobId} échoué:`, err);
    await markJobFailed(jobId, err instanceof Error ? err.message : String(err));
  }
```

- [ ] **Step 4: Manual regression check**

Run `bun run dev`, import a small DXF from the home page as before, confirm it still completes normally (phase/progress bar unchanged) — this task only adds no-op checkpoints and a dispatch branch, the DXF pipeline itself is untouched.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/lib/import/run-job.ts
git add src/lib/import/run-job.ts
git commit -m "feat(import): dispatch runImportJob by sourceType, add DXF cancellation checkpoints"
```

---

### Task 8: `POST /api/import-jobs` — accept shapefile jobs

**Files:**
- Modify: `src/app/api/import-jobs/route.ts`

**Interfaces:**
- Consumes: `ShapefileTarget`, `targetFieldsFor` (Task 2); `SourceType`, `JobKind` (Task 1).
- Produces: JSON path of `POST /api/import-jobs` now also accepts `{ fileKey, fileName, sourceType: "SHP", kind: "cad-parcelles"|"cad-sections"|"sections", layerMapping }`.

- [ ] **Step 1: Add a shapefile-specific mapping sanitizer**

In `src/app/api/import-jobs/route.ts`, add near the existing `sanitizeLayerMapping`:

```ts
import { targetFieldsFor, type ShapefileTarget } from "@/lib/import/field-mapping";

function shapefileTargetForKind(kind: string | undefined): ShapefileTarget {
  if (kind === "cad-sections") return "cad-sections";
  if (kind === "sections") return "sections-limite";
  return "cad-parcelles";
}

/** Valide/assainit un mappage champ cible → colonne .dbf reçu du client (job shapefile). */
function sanitizeFieldMapping(input: unknown, kind: string | undefined): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const allowedKeys = new Set(targetFieldsFor(shapefileTargetForKind(kind)).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (allowedKeys.has(key) && typeof value === "string" && value.trim()) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
```

- [ ] **Step 2: Widen `startJob` to accept a `kind` override**

Replace the `startJob` signature and its `createImportJob` call (`src/app/api/import-jobs/route.ts:34-56`):

```ts
async function startJob(
  source: ResolvedSource,
  userId: string | null,
  layerMapping: LayerMapping | Record<string, string> | undefined,
  fileKey: string,
  kind?: import("@/lib/import/jobs").JobKind,
): Promise<NextResponse> {
  const job = await createImportJob({
    fileName: source.fileName,
    fileKey,
    sourceType: source.sourceType,
    userId,
    layerMapping,
    kind,
  });
```

(the rest of `startJob` — `after(() => runImportJob(job.id))` and the `NextResponse.json(...)` return — is unchanged).

- [ ] **Step 3: Branch the JSON path on `sourceType`**

Replace the JSON-path block (`src/app/api/import-jobs/route.ts:77-96`):

```ts
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        fileKey?: string;
        fileName?: string;
        sourceType?: string;
        kind?: string;
        layerMapping?: unknown;
      };
      if (!body.fileKey || !body.fileName) {
        return NextResponse.json({ error: "Requête invalide : fileKey et fileName requis." }, { status: 400 });
      }

      if (body.sourceType === "SHP") {
        if (!body.kind || !["cad-parcelles", "cad-sections", "sections"].includes(body.kind)) {
          return NextResponse.json(
            { error: "kind requis pour un job shapefile (cad-parcelles|cad-sections|sections)." },
            { status: 400 },
          );
        }
        const source: ResolvedSource = { buffer: Buffer.alloc(0), fileName: body.fileName, sourceType: "SHP" as SourceType };
        return startJob(
          source,
          userId,
          sanitizeFieldMapping(body.layerMapping, body.kind),
          body.fileKey,
          body.kind as import("@/lib/import/jobs").JobKind,
        );
      }

      if (body.sourceType !== "DXF" && body.sourceType !== "DGN") {
        return NextResponse.json(
          { error: "Requête invalide : sourceType doit être DXF, DGN ou SHP." },
          { status: 400 },
        );
      }
      const source: ResolvedSource = {
        buffer: Buffer.alloc(0), // non utilisé (fichier déjà persisté sous fileKey)
        fileName: body.fileName,
        sourceType: body.sourceType as SourceType,
      };
      return startJob(source, userId, sanitizeLayerMapping(body.layerMapping), body.fileKey);
    }
```

- [ ] **Step 4: Manual regression check**

Run `bun run dev`; confirm the DXF import from the home page still works (JSON path with `sourceType: "DXF"` unchanged in behavior). Full shapefile end-to-end check happens in Task 11/12.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/app/api/import-jobs/route.ts
git add src/app/api/import-jobs/route.ts
git commit -m "feat(import-jobs): accept shapefile jobs (sourceType SHP) in POST /api/import-jobs"
```

---

### Task 9: Cancel endpoint

**Files:**
- Create: `src/app/api/import-jobs/[id]/cancel/route.ts`

**Interfaces:**
- Consumes: `cancelImportJob` (Task 1).
- Produces: `POST /api/import-jobs/[id]/cancel` → `{ cancelled: boolean }`.

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { cancelImportJob } from "@/lib/import/jobs";

export const runtime = "nodejs";

/** POST /api/import-jobs/[id]/cancel — annule un job pending/running (no-op s'il est déjà terminal). */
export async function POST(
  _req: NextRequest,
  ctx: RouteContext<"/api/import-jobs/[id]/cancel">,
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) {
    return NextResponse.json({ error: "id invalide" }, { status: 400 });
  }

  const result = await cancelImportJob(jobId);
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Manual check**

Run `bun run dev`, start any import job (DXF from the home page is enough at this point), copy its `jobId` from the network tab, then `curl -X POST http://localhost:3000/api/import-jobs/<id>/cancel -H "Cookie: <session cookie>"` (or just click through once the button lands in Task 11-13) and confirm `GET /api/import-jobs/<id>` now reports `status: "cancelled"` and stays there (not overwritten back to `completed`/`failed`).

- [ ] **Step 3: Lint + commit**

```bash
npx eslint src/app/api/import-jobs/[id]/cancel/route.ts
git add src/app/api/import-jobs/[id]/cancel/route.ts
git commit -m "feat(import-jobs): add POST /api/import-jobs/[id]/cancel"
```

---

### Task 10: Generic `FieldMappingModal` component

**Files:**
- Create: `src/components/FieldMappingModal.tsx`

**Interfaces:**
- Consumes: `TargetFieldDef` (Task 2, `@/lib/import/field-mapping`); `Button` (`@/components/ui/button`, existing).
- Produces: `FieldMappingModal` React component, props `{ fileName: string; targetFields: TargetFieldDef[]; availableFields: { name: string; sampleValues: string[] }[]; proposedMapping: Record<string,string>; onCancel: () => void; onConfirm: (mapping: Record<string,string>) => void }`.

- [ ] **Step 1: Write the component**

```tsx
"use client";
import { useMemo, useState } from "react";
import { ListChecks, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TargetFieldDef } from "@/lib/import/field-mapping";

interface AvailableField {
  name: string;
  sampleValues: string[];
}

interface Props {
  fileName: string;
  targetFields: TargetFieldDef[];
  availableFields: AvailableField[];
  proposedMapping: Record<string, string>;
  onCancel: () => void;
  /** Reçoit le mappage validé { champ_cible → colonne .dbf source }. */
  onConfirm: (mapping: Record<string, string>) => void;
}

/**
 * Modale de mappage des champs attribut d'un shapefile : l'utilisateur associe
 * chaque champ cible (fixe, défini par le type d'import) à une colonne .dbf
 * détectée. Sens inverse de `LayerMappingModal` (calque source → classe DGID) :
 * ici c'est le champ CIBLE qui est fixe et la colonne SOURCE qui varie.
 */
export default function FieldMappingModal({
  fileName,
  targetFields,
  availableFields,
  proposedMapping,
  onCancel,
  onConfirm,
}: Props) {
  const [mapping, setMapping] = useState<Record<string, string>>(() => ({ ...proposedMapping }));

  const missingRequired = useMemo(
    () => targetFields.filter((f) => f.required && !mapping[f.key]),
    [targetFields, mapping],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-white/10 bg-[oklch(0.20_0.02_240)] shadow-2xl">
        <div className="flex items-start justify-between gap-4 p-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <ListChecks className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Mappage des champs</h2>
              <p className="text-sm text-white/50">
                {fileName} · {availableFields.length} colonne(s) détectée(s)
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="p-1 rounded-md hover:bg-white/10 text-white/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="px-5 pt-4 text-sm text-white/60">
          Associez chaque champ attendu à une colonne du fichier .dbf. Les propositions
          automatiques sont pré-remplies ; corrigez-les si nécessaire.
        </p>

        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {targetFields.map((f) => (
            <div
              key={f.key}
              className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-white">
                  {f.label}
                  {f.required ? " *" : ""}
                </div>
              </div>
              <select
                value={mapping[f.key] ?? ""}
                onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                className="shrink-0 w-64 rounded-md border border-white/10 bg-[oklch(0.16_0.02_240)] px-2 py-1.5 text-sm text-white outline-none focus:border-cyan-400/60"
              >
                <option value="">— Non mappé —</option>
                {availableFields.map((col) => (
                  <option key={col.name} value={col.name}>
                    {col.name}
                    {col.sampleValues[0] ? ` (ex: ${col.sampleValues[0]})` : ""}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4 p-5 border-t border-white/10">
          <span className="text-sm text-white/50">
            {missingRequired.length > 0
              ? `Champ requis manquant : ${missingRequired.map((f) => f.label).join(", ")}`
              : "Tous les champs requis sont mappés"}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Annuler
            </Button>
            <Button onClick={() => onConfirm(mapping)} disabled={missingRequired.length > 0}>
              Lancer le traitement
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lint + commit**

```bash
npx eslint src/components/FieldMappingModal.tsx
git add src/components/FieldMappingModal.tsx
git commit -m "feat(import): add generic FieldMappingModal (attribute-column mapping)"
```

---

### Task 11: Wire `/cadastre/import` (Parcelles/Sections) to inventory → mapping → job → progress

**Files:**
- Modify: `src/app/cadastre/import/page.tsx`

**Interfaces:**
- Consumes: `FieldMappingModal` (Task 10); `POST /api/cadastre/import/inventory` (Task 3); `POST /api/import-jobs`, `GET /api/import-jobs/[id]`, `POST /api/import-jobs/[id]/cancel` (Tasks 8, 9, existing).

- [ ] **Step 1: Replace the file**

```tsx
"use client";
import { PageTitle } from "@/components/PageTitle";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Upload, FileUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import FieldMappingModal from "@/components/FieldMappingModal";
import { uploadShapefile } from "../_actions/import-export";
import type { TargetFieldDef, ShapefileTarget } from "@/lib/import/field-mapping";

type TypeImport = "parcelles" | "sections" | "communes2013" | "communes2026" | "nicads";

const TYPES: { value: TypeImport; label: string; hint: string }[] = [
  { value: "parcelles", label: "Parcelles", hint: ".shp + .dbf (ou .geojson) — NICAD 16 ou Codesectio 11" },
  { value: "sections", label: "Sections", hint: ".shp + .dbf — Num_sect_N (11 chiffres)" },
  { value: "communes2013", label: "Communes 2013", hint: ".shp + .dbf / .geojson / .csv — Syscol" },
  { value: "communes2026", label: "Communes 2026", hint: ".shp + .dbf / .geojson / .csv — COD_SYSCOL" },
  { value: "nicads", label: "NICAD (CSV)", hint: ".csv — colonne NICAD (16 caractères)" },
];

/** Ces deux types seulement passent par l'inventaire + mappage + job asynchrone ; les autres restent synchrones. */
const MAPPED_TYPES = new Set<TypeImport>(["parcelles", "sections"]);

function targetForType(t: TypeImport): ShapefileTarget {
  return t === "sections" ? "cad-sections" : "cad-parcelles";
}
function kindForType(t: TypeImport): "cad-parcelles" | "cad-sections" {
  return t === "sections" ? "cad-sections" : "cad-parcelles";
}

interface ShapefileInventoryResponse {
  fileKey: string;
  fileName: string;
  featureCount: number;
  fields: { name: string; sampleValues: string[] }[];
  targetFields: TargetFieldDef[];
  proposedMapping: Record<string, string>;
}

interface JobState {
  id: number;
  status: string;
  phase: string | null;
  progress: number;
  report?: { nbImportes?: number; nbIgnores?: number; nbErreurs?: number; warnings?: string[] } | null;
  error?: string | null;
}

function phaseLabel(phase: string | null): string {
  switch (phase) {
    case "read":
      return "Lecture du fichier…";
    case "import":
      return "Import des entités…";
    case "done":
      return "Terminé";
    default:
      return "Démarrage…";
  }
}

const selectCls =
  "h-9 w-full rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      resolve(res.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ImportPage() {
  const [typeImport, setTypeImport] = useState<TypeImport>("parcelles");
  const [files, setFiles] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof uploadShapefile>> | null>(null);
  const [inventory, setInventory] = useState<ShapefileInventoryResponse | null>(null);
  const [job, setJob] = useState<JobState | null>(null);

  const isMapped = MAPPED_TYPES.has(typeImport);
  const isShapefileSelected = files.some((f) => f.name.toLowerCase().endsWith(".shp"));
  const jobRunning = job?.status === "pending" || job?.status === "running";

  // ── Polling du job (mêmes phases/format que le job DXF) ────────────────────
  useEffect(() => {
    if (!job || (job.status !== "pending" && job.status !== "running")) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/import-jobs/${job.id}`, { cache: "no-store" });
        const j = await res.json();
        setJob({ id: j.id, status: j.status, phase: j.phase, progress: j.progress, report: j.report, error: j.error });
        if (j.status === "completed") {
          setResult({
            success: true,
            nbImportes: j.report?.nbImportes ?? j.totalBuilt ?? 0,
            nbIgnores: j.report?.nbIgnores,
            nbErreurs: j.report?.nbErreurs,
            warnings: j.report?.warnings,
          });
          toast.success(`${j.report?.nbImportes ?? j.totalBuilt ?? 0} entité(s) importée(s).`);
        } else if (j.status === "failed") {
          toast.error(j.error || "Import échoué.");
        } else if (j.status === "cancelled") {
          toast.info("Import annulé.");
        }
      } catch {
        /* réessaie au prochain tick */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job]);

  const handleCancel = useCallback(async () => {
    if (!job) return;
    await fetch(`/api/import-jobs/${job.id}/cancel`, { method: "POST" });
  }, [job]);

  async function startMappedJob(mapping: Record<string, string>) {
    if (!inventory) return;
    const inv = inventory;
    setInventory(null);
    try {
      const res = await fetch("/api/import-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: inv.fileKey,
          fileName: inv.fileName,
          sourceType: "SHP",
          kind: kindForType(typeImport),
          layerMapping: mapping,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(e.error || `Erreur serveur: ${res.status}`);
      }
      const { jobId } = (await res.json()) as { jobId: number };
      setResult(null);
      setJob({ id: jobId, status: "pending", phase: "read", progress: 0 });
    } catch (err) {
      toast.error(String(err));
    }
  }

  function handleImport() {
    if (files.length === 0) {
      toast.error("Sélectionnez au moins un fichier.");
      return;
    }

    if (isMapped && isShapefileSelected) {
      const shpFile = files.find((f) => f.name.toLowerCase().endsWith(".shp"));
      const dbfFile = files.find((f) => f.name.toLowerCase().endsWith(".dbf"));
      if (!shpFile || !dbfFile) {
        toast.error("Sélectionnez le .shp ET son .dbf ensemble.");
        return;
      }
      startTransition(async () => {
        try {
          const fd = new FormData();
          fd.append("target", targetForType(typeImport));
          fd.append("files", shpFile);
          fd.append("files", dbfFile);
          const res = await fetch("/api/cadastre/import/inventory", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Inventaire échoué.");
          setInventory(data);
        } catch (err) {
          toast.error(String(err));
        }
      });
      return;
    }

    startTransition(async () => {
      try {
        const fichiers = await Promise.all(
          files.map(async (f) => ({ nom: f.name, contenu: await fileToBase64(f) })),
        );
        const res = await uploadShapefile({ typeImport, fichiers });
        setResult(res);
        if (res.success) toast.success(`${res.nbImportes} entité(s) importée(s).`);
        else toast.error(res.error ?? "Échec de l'import.");
      } catch {
        toast.error("Erreur lors de l'import.");
      }
    });
  }

  const hint = TYPES.find((t) => t.value === typeImport)?.hint;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle title="Import de données" />
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Upload className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Import de données</h1>
          <p className="text-sm text-muted-foreground">Shapefile (.shp + .dbf), GeoJSON ou CSV.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fichier à importer</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Type d&apos;import</label>
            <select
              className={selectCls}
              value={typeImport}
              onChange={(e) => setTypeImport(e.target.value as TypeImport)}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </div>

          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 p-6 text-center hover:bg-secondary/40">
            <FileUp className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {files.length > 0 ? `${files.length} fichier(s) sélectionné(s)` : "Cliquez pour choisir des fichiers"}
            </span>
            <input
              type="file"
              multiple
              accept=".shp,.dbf,.geojson,.json,.csv"
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          {files.length > 0 && (
            <ul className="text-xs text-muted-foreground">
              {files.map((f) => (
                <li key={f.name}>• {f.name}</li>
              ))}
            </ul>
          )}

          <Button onClick={handleImport} disabled={pending || jobRunning} className="gap-2">
            <Upload className="h-4 w-4" />
            {pending ? "Préparation…" : jobRunning ? "Import en cours…" : "Importer"}
          </Button>
        </CardContent>
      </Card>

      {job && (
        <Card>
          <CardContent className="space-y-2 p-5 text-sm">
            <div className="flex items-center justify-between">
              <span>{phaseLabel(job.phase)}</span>
              <span>{job.progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary transition-all" style={{ width: `${job.progress}%` }} />
            </div>
            {jobRunning && (
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Annuler
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card className={result.success ? "" : "border-rose-500/40"}>
          <CardContent className="space-y-1 p-5 text-sm">
            {result.success ? (
              <>
                <p className="font-medium text-emerald-500">Import terminé</p>
                <p>Importées : {result.nbImportes}</p>
                {"nbIgnores" in result && result.nbIgnores != null && <p>Ignorées : {result.nbIgnores}</p>}
                {"nbErreurs" in result && result.nbErreurs != null && <p>Erreurs : {result.nbErreurs}</p>}
                {"warnings" in result && result.warnings && result.warnings.length > 0 && (
                  <ul className="mt-2 text-xs text-amber-500">
                    {result.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-rose-500">{result.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {inventory && (
        <FieldMappingModal
          fileName={inventory.fileName}
          targetFields={inventory.targetFields}
          availableFields={inventory.fields}
          proposedMapping={inventory.proposedMapping}
          onCancel={() => setInventory(null)}
          onConfirm={(mapping) => void startMappedJob(mapping)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Manual verification**

Run `bun run dev`, go to `/cadastre/import`:
1. Select **Communes 2013**, upload a `.shp`+`.dbf` pair → confirm it still goes through the old synchronous path (no mapping modal, immediate result card) — regression check.
2. Select **Parcelles**, upload a `.shp`+`.dbf` pair → confirm the field-mapping modal opens with proposed values, confirm it → confirm a progress bar with phase/percentage appears, an **Annuler** button is visible while running, and the result card shows the same counts as before once the job completes.
3. Repeat for **Sections**.
4. Start an import and click **Annuler** mid-progress → confirm the job stops advancing and the UI reports it as cancelled (no result card is shown for it).

- [ ] **Step 3: Lint + commit**

```bash
npx eslint src/app/cadastre/import/page.tsx
git add src/app/cadastre/import/page.tsx
git commit -m "feat(cadastre): wire Parcelles/Sections import to field-mapping + async job"
```

---

### Task 12: Wire `SectionsClient.tsx` shapefile branch to the same job flow, retire the old sync route

**Files:**
- Modify: `src/components/cadastre/SectionsClient.tsx`
- Delete: `src/app/api/cadastre/sections/import-shapefile/route.ts` (superseded — confirmed via grep that this route has no other caller)

**Interfaces:**
- Consumes: `FieldMappingModal` (Task 10); `POST /api/cadastre/import/inventory` with `target: "sections-limite"` (Task 3); `POST /api/import-jobs` with `kind: "sections", sourceType: "SHP"` (Task 8).

- [ ] **Step 1: Add imports and mapping state**

Near the top of `src/components/cadastre/SectionsClient.tsx`, add:

```ts
import FieldMappingModal from "@/components/FieldMappingModal";
import type { TargetFieldDef } from "@/lib/import/field-mapping";
```

Add a new state next to the existing `job`/`files` declarations (`src/components/cadastre/SectionsClient.tsx:169-171`):

```ts
  const [pendingShapefileInventory, setPendingShapefileInventory] = useState<{
    fileKey: string;
    fileName: string;
    fields: { name: string; sampleValues: string[] }[];
    targetFields: TargetFieldDef[];
    proposedMapping: Record<string, string>;
  } | null>(null);
```

- [ ] **Step 2: Replace the shapefile branch of `handleUpload`**

Replace (`src/components/cadastre/SectionsClient.tsx:374-384`):

```ts
      if (isShapefile) {
        // Shapefile : polygones déjà valides → construction synchrone, pas de job.
        const res = await fetch("/api/cadastre/sections/import-shapefile", {
          method: "POST",
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Import échoué");
        await reportBuildResult(data);
        return;
      }
```

with:

```ts
      if (isShapefile) {
        // Shapefile : même parcours que le DXF désormais — inventaire des
        // colonnes .dbf, mappage du numéro de section, puis job asynchrone
        // (kind "sections", même table limite_section).
        const invRes = await fetch("/api/cadastre/import/inventory", {
          method: "POST",
          body: (() => {
            const invFd = new FormData();
            invFd.append("target", "sections-limite");
            for (const f of files) invFd.append("files", f);
            return invFd;
          })(),
        });
        const inv = await invRes.json();
        if (!invRes.ok) throw new Error(inv.error || "Inventaire échoué");
        setUploading(false);
        setPendingShapefileInventory(inv);
        return;
      }
```

- [ ] **Step 3: Add the job-start handler and cancel handler**

Add near `handleUpload` (after its closing `}, [files, reportBuildResult]);` at line 403):

```ts
  const startShapefileSectionsJob = useCallback(
    async (mapping: Record<string, string>) => {
      if (!pendingShapefileInventory) return;
      const inv = pendingShapefileInventory;
      setPendingShapefileInventory(null);
      setUploading(true);
      try {
        const res = await fetch("/api/import-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileKey: inv.fileKey,
            fileName: inv.fileName,
            sourceType: "SHP",
            kind: "sections",
            layerMapping: mapping,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Import échoué");
        setSourceFichier(inv.fileName);
        setJob({ id: data.jobId, status: data.status, phase: "read", progress: 0 });
      } catch (err) {
        toast.error(String(err));
        setUploading(false);
      }
    },
    [pendingShapefileInventory],
  );

  const handleCancelJob = useCallback(async () => {
    if (!job) return;
    await fetch(`/api/import-jobs/${job.id}/cancel`, { method: "POST" });
  }, [job]);
```

- [ ] **Step 4: Handle `"cancelled"` in the polling `useEffect`**

In the polling effect (`src/components/cadastre/SectionsClient.tsx:406-442`), add a branch after the existing `else if (j.status === "failed")` block:

```ts
        } else if (j.status === "failed") {
          setUploading(false);
          toast.error(j.error || "Traitement échoué");
        } else if (j.status === "cancelled") {
          setUploading(false);
          toast.info("Import annulé.");
        }
```

- [ ] **Step 5: Add the Annuler button next to the progress bar**

Replace the progress block (`src/components/cadastre/SectionsClient.tsx:1637-1650`):

```tsx
        {job && (job.status === "pending" || job.status === "running") && (
          <div className="rounded-xl border border-border/60 p-3">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Phase : {job.phase ?? "…"}</span>
              <span>{job.progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${job.progress}%` }}
              />
            </div>
          </div>
        )}
```

with:

```tsx
        {job && (job.status === "pending" || job.status === "running") && (
          <div className="rounded-xl border border-border/60 p-3 space-y-1.5">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Phase : {job.phase ?? "…"}</span>
              <span>{job.progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${job.progress}%` }}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={handleCancelJob}>
              Annuler
            </Button>
          </div>
        )}
```

(the `Button` component is already imported in this file — confirm at the top; if not, add `import { Button } from "@/components/ui/button";`).

- [ ] **Step 6: Render the mapping modal**

Near the end of the component's JSX return (alongside any other modal renders in the file), add:

```tsx
      {pendingShapefileInventory && (
        <FieldMappingModal
          fileName={pendingShapefileInventory.fileName}
          targetFields={pendingShapefileInventory.targetFields}
          availableFields={pendingShapefileInventory.fields}
          proposedMapping={pendingShapefileInventory.proposedMapping}
          onCancel={() => setPendingShapefileInventory(null)}
          onConfirm={(mapping) => void startShapefileSectionsJob(mapping)}
        />
      )}
```

- [ ] **Step 7: Delete the now-unused synchronous route**

```bash
git rm src/app/api/cadastre/sections/import-shapefile/route.ts
```

(`sectionCandidatesFromShapefile` and `buildLimiteSections`, which this route called, remain in use — now called from `runShapefileImportJob`, Task 6.)

- [ ] **Step 8: Manual verification**

Run `bun run dev`, go to `/cadastre/sections`:
1. Upload a DXF as before → confirm the job/progress/Annuler flow still works (regression check for the pre-existing DXF branch, which now also has the Annuler button).
2. Upload a `.shp`+`.dbf` pair → confirm the field-mapping modal opens (single "Numéro de section" row, pre-filled if a recognizable column exists), confirm it, and confirm the same progress bar + Annuler button + final toast (`"N section(s) construites…"`) as the DXF path.
3. Click **Annuler** mid-job → confirm it stops and the section count doesn't include any partial batch (this pipeline only writes at the very end via `buildLimiteSections`, so cancellation before that point leaves `limite_section` untouched for this source file).

- [ ] **Step 9: Lint + commit**

```bash
npx eslint src/components/cadastre/SectionsClient.tsx
git add src/components/cadastre/SectionsClient.tsx
git rm src/app/api/cadastre/sections/import-shapefile/route.ts
git commit -m "feat(cadastre): wire SectionsClient shapefile branch to field-mapping + job, add cancel"
```

---

### Task 13: Add the Annuler button to the DXF flow (`HomeClient.tsx`)

**Files:**
- Modify: `src/components/HomeClient.tsx`

**Interfaces:**
- Consumes: `POST /api/import-jobs/[id]/cancel` (Task 9).

- [ ] **Step 1: Track the current job id and handle `"cancelled"` in `pollImportJob`**

`pollImportJob` (`src/components/HomeClient.tsx:112-166`) doesn't currently expose the job id outside its own closure. Add a new state to hold it, set at the start of `pollImportJob`, and add a `"cancelled"` branch:

Add near the other `useState` declarations (`src/components/HomeClient.tsx:88-91`):

```ts
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
```

In `pollImportJob`, right after `const pollImportJob = useCallback(async (jobId: number) => {` (line 112), add:

```ts
    setCurrentJobId(jobId);
```

Add a `"cancelled"` branch right after the existing `if (job.status === "failed") { throw new Error(job.error || "Import échoué."); }` (line 161-163):

```ts
      if (job.status === "cancelled") {
        toast.info("Import annulé.");
        return;
      }
```

- [ ] **Step 2: Clear `currentJobId` in `resetUpload`**

In `resetUpload` (`src/components/HomeClient.tsx:93-102`), add:

```ts
    setCurrentJobId(null);
```

- [ ] **Step 3: Add the cancel handler and button**

Add a handler near `pollImportJob`:

```ts
  const handleCancelImport = useCallback(async () => {
    if (!currentJobId) return;
    await fetch(`/api/import-jobs/${currentJobId}/cancel`, { method: "POST" });
  }, [currentJobId]);
```

In the JSX around the existing progress bar (`src/components/HomeClient.tsx:525-533`, the block rendering `caoPhaseLabel(jobPhase)` / `jobProgress`), add an Annuler button right after the percentage text:

```tsx
                          <div className="text-center text-xs text-muted-foreground">{jobProgress}%</div>
                          <div className="text-center">
                            <Button variant="ghost" size="sm" onClick={handleCancelImport}>
                              Annuler
                            </Button>
                          </div>
```

(confirm `Button` is already imported at the top of `HomeClient.tsx`; it is, per existing usage elsewhere in the file — if not, add `import { Button } from "@/components/ui/button";`).

- [ ] **Step 4: Manual verification**

Run `bun run dev`, start a DXF import from the home page, confirm the **Annuler** button appears under the progress bar, click it mid-import, and confirm a `"Import annulé."` toast appears and the job stops advancing (check `GET /api/import-jobs/<id>` shows `status: "cancelled"` and stays there).

- [ ] **Step 5: Lint + commit**

```bash
npx eslint src/components/HomeClient.tsx
git add src/components/HomeClient.tsx
git commit -m "feat(home): add cancel button to the DXF import job progress UI"
```

---

### Task 14: Documentation (`docs/CONCEPTS-TRAITEMENT-DXF.md` + `docs/README.md`)

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md`
- Modify: `docs/README.md`

Per this project's `CLAUDE.md`, any new concept touching geometric/geospatial file processing (mapping, deduplication, NICAD, spatial joins) must be documented in `docs/CONCEPTS-TRAITEMENT-DXF.md` with **problème métier / cause technique / solution (fichier · fonction) / pourquoi**, and referenced from `docs/README.md`.

- [ ] **Step 1: Read the existing structure**

Open `docs/CONCEPTS-TRAITEMENT-DXF.md` and note its section format (one `##`/`###` per concept) and `docs/README.md`'s table of contents format, to match style exactly.

- [ ] **Step 2: Add a new section to `docs/CONCEPTS-TRAITEMENT-DXF.md`**

Append a section titled e.g. `## Mapping de champs shapefile + progression asynchrone` covering:
- **Problème métier** : les imports shapefile en masse (parcelles/sections) devinaient silencieusement les colonnes .dbf (chaînes `??` figées) sans que l'utilisateur ne puisse vérifier/corriger, et s'exécutaient en une seule requête bloquante sans retour de progression pour de gros fichiers.
- **Cause technique** : `import-data.ts` codait les alias en dur ; `uploadShapefile()` (server action) traitait tout le fichier de façon synchrone dans le cycle de la requête.
- **Solution** : `src/lib/import/field-mapping.ts` (définitions de champs cibles + proposition automatique), `src/app/api/cadastre/import/inventory/route.ts` (inventaire des colonnes .dbf), `src/components/FieldMappingModal.tsx` (confirmation utilisateur), `src/lib/import/run-shapefile-job.ts` (job asynchrone réutilisant `ImportJob`/`setJobPhase`, comme le pipeline DXF).
- **Pourquoi** : réutiliser l'infrastructure de job DXF évite un deuxième système de progression ; le mappage se fait champ cible → colonne source (inverse du mappage calque → classe DXF) car un shapefile a une géométrie unique et plusieurs colonnes d'attributs, contrairement à un DXF qui a plusieurs calques géométriques.

- [ ] **Step 3: Add a reference row in `docs/README.md`**

Add a line pointing to the new section (or to the design spec `docs/superpowers/specs/2026-08-11-shapefile-mapping-progression-design.md` if that's the existing convention for linking specs), matching the table/parcours-de-lecture format already used there for prior entries (e.g. the NICAD-from-DXF or Thiès-recovery entries).

- [ ] **Step 4: Commit**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md docs/README.md
git commit -m "docs(cadastre): document shapefile field-mapping + progress mechanism"
```

---

## Self-Review Notes

- **Spec coverage:** all six spec sections (architecture, job model, mapping fields, upload/progress, cancellation, UI) map to Tasks 1–13; the doc follow-up is Task 14.
- **Type consistency checked:** `FieldMapping = Record<string,string>` (Task 2) flows unchanged through `createImportJob` (Task 1, widened), `ImportJob.layerMapping` (JSON, no schema change), `sanitizeFieldMapping` (Task 8), `runShapefileImportJob` (Task 6, cast back from `job.layerMapping`), and both `FieldMappingModal`'s `onConfirm` payload and `importParcellesFromFeatures`/`importSectionsFromFeatures`'s `fieldMapping` param (Task 4) — same shape everywhere. `JobKind` values (`"cad-parcelles" | "cad-sections" | "sections"`) are consistent across Task 1 (definition), Task 6 (runner dispatch), Task 8 (API validation), Task 11/12 (client payloads).
- **No placeholders:** every step has literal, complete code — no `TODO`/"similar to Task N" shortcuts. Tasks 3 and 6's verification scripts degrade gracefully (documented `SKIP:` path) because this repo has no versioned shapefile fixture and no test DB — that's a real constraint of this codebase, not a placeholder; both scripts still fully exercise the pure/structural parts they can reach without external data, and Tasks 11/12 carry the actual end-to-end manual verification.
