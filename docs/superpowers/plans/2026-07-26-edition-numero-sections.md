# Édition du numéro pour les sections sans numéro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin attribute a `numSection` to a `limite_section` row that came out of extraction without one, from both the sections table and the map popup, with a per-commune uniqueness guard and a dedicated filter to find these rows.

**Architecture:** One new backend endpoint (`POST /api/cadastre/sections/numero`) backed by two new query helpers in the existing raw-SQL data layer (`sections-data.ts`), plus additive UI in the existing `SectionsClient.tsx` (inline table edit, map popup field, filter toggle). No schema change — the uniqueness check reuses the existing `@@index([syscolCommune, numSection])`.

**Tech Stack:** Next.js App Router API route (`route.ts`, Node runtime), Prisma raw SQL (`$queryRaw`/`$executeRaw`), React client component with Leaflet (imperative DOM for popups, as the rest of the file already does).

## Global Constraints

- Auth guard on the new route: session required + `role === "ADMIN"` — exact same pattern as `correct`, `merge`, `delete` routes in this module.
- No automated test runner exists in this repo (`package.json` has no `test` script, no `*.test.ts`/`*.spec.ts` files) — verification is `npx tsc --noEmit`, `npx eslint <file>`, and manual check via `npm run dev`, matching how the sibling `correct`/`merge`/`delete` features were built.
- Editable field: `numSection` only. Only for sections where `numSection` is currently `null`/empty — never overwrite an existing number through this flow.
- Duplicate numbers within the same `syscolCommune` are rejected (409), not merged automatically.
- Follow existing code style in `SectionsClient.tsx`: French UI copy and comments, Tailwind utility classes matching neighboring buttons, `toast.success`/`toast.error` from `sonner` for feedback, no `window.confirm` (this action isn't destructive, so no `ConfirmDialog` needed).
- Doc requirement from this repo's `CLAUDE.md`: any new geometric/topological processing concept must be documented in `docs/CONCEPTS-TRAITEMENT-DXF.md` (Task 6).

---

### Task 1: Data layer — `sections-data.ts`

**Files:**
- Modify: `src/lib/cadastre/sections-data.ts:114-124` (extend `getSection`)
- Modify: `src/lib/cadastre/sections-data.ts:163-169` (add two functions after `deleteSection`)

**Interfaces:**
- Consumes: `prisma` from `@/lib/prisma` (already imported in this file).
- Produces:
  - `getSection(id: number): Promise<{ geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null; syscolCommune: string | null; commune: string | null } | null>` — extended return shape (additive fields), used by Task 2.
  - `findSectionNumeroConflict(syscolCommune: string | null, numSection: string, excludeId: number): Promise<{ id: number; commune: string | null } | null>` — used by Task 2.
  - `updateSectionNumero(id: number, numSection: string): Promise<void>` — used by Task 2.

- [ ] **Step 1: Extend `getSection` to also return `syscolCommune` and `commune`**

Find this exact block (`src/lib/cadastre/sections-data.ts:114-124`):

```ts
/** GeoJSON + lot d'une section (pour appliquer une correction géométrique). */
export async function getSection(
  id: number,
): Promise<{ geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ geomGeoJson: GeoJSON.Polygon | GeoJSON.MultiPolygon; sourceFichier: string; numSection: string | null }>
  >`
    SELECT "geomGeoJson", "sourceFichier", "numSection" FROM "limite_section" WHERE id = ${id}
  `;
  return rows[0] ?? null;
}
```

Replace with:

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

This is additive (new fields on the return type) — the two existing callers (`src/app/api/cadastre/sections/correct/route.ts`, indirectly via `getOverlap`+`getSection`) only destructure `geomGeoJson`, so they keep compiling unchanged.

- [ ] **Step 2: Add `findSectionNumeroConflict` and `updateSectionNumero`**

Find this exact block (`src/lib/cadastre/sections-data.ts:163-171`):

```ts
/** Supprime une section (et ses chevauchements référencés). */
export async function deleteSection(id: number): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "limite_section_overlap" WHERE "sectionAId" = ${id} OR "sectionBId" = ${id}
  `;
  await prisma.$executeRaw`DELETE FROM "limite_section" WHERE id = ${id}`;
}

/**
 * (Re)calcule les chevauchements surfaciques d'un lot. Préserve les paires
```

Replace with:

```ts
/** Supprime une section (et ses chevauchements référencés). */
export async function deleteSection(id: number): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "limite_section_overlap" WHERE "sectionAId" = ${id} OR "sectionBId" = ${id}
  `;
  await prisma.$executeRaw`DELETE FROM "limite_section" WHERE id = ${id}`;
}

/**
 * Cherche une AUTRE section de la même commune portant déjà ce numéro —
 * l'unicité du numéro de section n'est vraie que PAR COMMUNE (cf.
 * build-sections.ts, clé de dissolution (syscol, numéro)). Sans commune
 * résolue (`syscolCommune` null), aucun contrôle n'est possible.
 */
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

/** Attribue un numéro à une section (n'affecte pas la géométrie ni les chevauchements). */
export async function updateSectionNumero(id: number, numSection: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "limite_section" SET "numSection" = ${numSection}, "updatedAt" = now() WHERE id = ${id}
  `;
}

/**
 * (Re)calcule les chevauchements surfaciques d'un lot. Préserve les paires
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint src/lib/cadastre/sections-data.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/cadastre/sections-data.ts
git commit -m "feat(sections): add numero attribution query helpers"
```

---

### Task 2: API route — `POST /api/cadastre/sections/numero`

**Files:**
- Create: `src/app/api/cadastre/sections/numero/route.ts`

**Interfaces:**
- Consumes: `auth` from `@/lib/auth`; `getSection`, `findSectionNumeroConflict`, `updateSectionNumero` from `@/lib/cadastre/sections-data` (Task 1).
- Produces: `POST /api/cadastre/sections/numero` accepting `{ sectionId: number, numSection: string }`, returning `{ success: true, sectionId: number, numSection: string }` on success, or `{ error: string }` with status 400/401/403/404/409/500. Consumed by Task 3 and Task 4 via `fetch`.

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getSection,
  findSectionNumeroConflict,
  updateSectionNumero,
} from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

/**
 * POST /api/cadastre/sections/numero — attribue un numéro à une section qui
 * n'en a pas encore (numSection NULL : libellé absent ou hors polygone lors
 * de l'extraction, cf. docs/CONCEPTS-TRAITEMENT-DXF.md §11). Refuse si la
 * section a déjà un numéro, ou si une autre section de la même commune
 * (syscolCommune) porte déjà ce numéro — le numéro de section n'est unique
 * QUE dans sa commune (cf. build-sections.ts).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

  let body: { sectionId?: number; numSection?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* corps vide */
  }
  const sectionId = Number(body.sectionId);
  const numSection = typeof body.numSection === "string" ? body.numSection.trim() : "";
  if (!Number.isInteger(sectionId) || !numSection) {
    return NextResponse.json({ error: "sectionId et numSection requis" }, { status: 400 });
  }

  try {
    const existing = await getSection(sectionId);
    if (!existing) {
      return NextResponse.json({ error: "Section introuvable" }, { status: 404 });
    }
    if (existing.numSection) {
      return NextResponse.json({ error: "Cette section a déjà un numéro" }, { status: 409 });
    }

    const conflict = await findSectionNumeroConflict(existing.syscolCommune, numSection, sectionId);
    if (conflict) {
      return NextResponse.json(
        {
          error: `Le numéro ${numSection} est déjà utilisé par la section #${conflict.id}${
            conflict.commune ? ` (${conflict.commune})` : ""
          } — fusionnez-les si c'est la même section.`,
        },
        { status: 409 },
      );
    }

    await updateSectionNumero(sectionId, numSection);
    return NextResponse.json({ success: true, sectionId, numSection });
  } catch (err) {
    console.error("[cadastre/sections/numero] POST", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint src/app/api/cadastre/sections/numero/route.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cadastre/sections/numero/route.ts
git commit -m "feat(sections): add POST /api/cadastre/sections/numero"
```

---

### Task 3: Table inline edit — assign a number from the sections table

**Files:**
- Modify: `src/components/cadastre/SectionsClient.tsx`

**Interfaces:**
- Consumes: `POST /api/cadastre/sections/numero` (Task 2); existing `SectionItem` type, `sections`/`setSections` state, `toast` from `sonner`.
- Produces: `performSetNumero(sectionId: number, rawValue: string): Promise<void>` and state `numeroEditId`, `numeroDraft`, `savingNumero` — consumed by Task 4 (map popup) which adds a second call site for `performSetNumero`, and Task 5 (filter) which reads `sections` the same way this task does.

- [ ] **Step 1: Add `Pencil` and `Check` icons to the lucide-react import**

Find (`SectionsClient.tsx:6-21`):

```tsx
import {
  Upload,
  Loader2,
  Scissors,
  Combine,
  Trash2,
  EyeOff,
  AlertTriangle,
  CheckCircle,
  FileUp,
  Download,
  X,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
```

Replace with:

```tsx
import {
  Upload,
  Loader2,
  Scissors,
  Combine,
  Trash2,
  EyeOff,
  AlertTriangle,
  CheckCircle,
  FileUp,
  Download,
  X,
  ChevronsLeft,
  ChevronsRight,
  Pencil,
  Check,
} from "lucide-react";
```

- [ ] **Step 2: Add state for the numero edit**

Find:

```tsx
  const [mergeSelection, setMergeSelection] = useState<number[]>([]);
  const mergeSelectionRef = useRef<number[]>([]);
  const [merging, setMerging] = useState(false);
  // Recadrage global : uniquement quand la PORTÉE des données change (premier
```

Replace with:

```tsx
  const [mergeSelection, setMergeSelection] = useState<number[]>([]);
  const mergeSelectionRef = useRef<number[]>([]);
  const [merging, setMerging] = useState(false);
  // Attribution de numéro pour une section qui n'en a pas — édition inline
  // partagée par la table et le popup carte (même handler performSetNumero).
  const [numeroEditId, setNumeroEditId] = useState<number | null>(null);
  const [numeroDraft, setNumeroDraft] = useState("");
  const [savingNumero, setSavingNumero] = useState<number | null>(null);
  // Recadrage global : uniquement quand la PORTÉE des données change (premier
```

- [ ] **Step 3: Add the `performSetNumero` handler**

Find:

```tsx
  const pendingSectionIds = useMemo(() => {
    const ids = new Set<number>();
    for (const o of overlaps) {
      if (o.status !== "PENDING") continue;
      ids.add(o.sectionAId);
      ids.add(o.sectionBId);
    }
    return ids;
  }, [overlaps]);

  // ── (Re)dessin des couches sections + chevauchements ───────────────────────
  useEffect(() => {
```

Replace with:

```tsx
  const pendingSectionIds = useMemo(() => {
    const ids = new Set<number>();
    for (const o of overlaps) {
      if (o.status !== "PENDING") continue;
      ids.add(o.sectionAId);
      ids.add(o.sectionBId);
    }
    return ids;
  }, [overlaps]);

  // ── Attribution d'un numéro à une section qui n'en a pas ────────────────────
  // Handler partagé par la table (édition inline) et le popup carte (Task 4).
  const performSetNumero = useCallback(async (sectionId: number, rawValue: string) => {
    const numSection = rawValue.trim();
    if (!numSection) {
      toast.error("Le numéro ne peut pas être vide.");
      return;
    }
    setSavingNumero(sectionId);
    try {
      const res = await fetch("/api/cadastre/sections/numero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId, numSection }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Attribution échouée");
      setSections((prev) =>
        prev.map((s) => (s.id === sectionId ? { ...s, numSection } : s)),
      );
      setNumeroEditId(null);
      toast.success(`Numéro ${numSection} attribué.`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSavingNumero(null);
    }
  }, []);

  // ── (Re)dessin des couches sections + chevauchements ───────────────────────
  useEffect(() => {
```

- [ ] **Step 4: Replace the numero table cell with an editable version**

Find (inside the sections `<table>`, the "Sect." column `<td>`):

```tsx
                              <td className="py-1 pr-2">
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className="h-2.5 w-2.5 rounded-sm"
                                    style={{
                                      background: sectionColor(
                                        pendingSectionIds.has(s.id),
                                      ),
                                    }}
                                  />
                                  {s.numSection ?? "—"}
                                </span>
                              </td>
```

Replace with:

```tsx
                              <td className="py-1 pr-2">
                                {numeroEditId === s.id ? (
                                  <span
                                    className="inline-flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      autoFocus
                                      value={numeroDraft}
                                      onChange={(e) => setNumeroDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          void performSetNumero(s.id, numeroDraft);
                                        } else if (e.key === "Escape") {
                                          setNumeroEditId(null);
                                        }
                                      }}
                                      placeholder="N°"
                                      className="h-5 w-14 rounded border border-border bg-background px-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                                    />
                                    <button
                                      onClick={() => void performSetNumero(s.id, numeroDraft)}
                                      disabled={savingNumero === s.id}
                                      title="Enregistrer le numéro"
                                      className="rounded p-0.5 text-green-500 transition-colors hover:bg-green-500/10 disabled:opacity-40"
                                    >
                                      {savingNumero === s.id ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <Check className="h-3 w-3" />
                                      )}
                                    </button>
                                    <button
                                      onClick={() => setNumeroEditId(null)}
                                      title="Annuler"
                                      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-secondary"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span
                                      className="h-2.5 w-2.5 rounded-sm"
                                      style={{
                                        background: sectionColor(
                                          pendingSectionIds.has(s.id),
                                        ),
                                      }}
                                    />
                                    {s.numSection ?? (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setNumeroEditId(s.id);
                                          setNumeroDraft("");
                                        }}
                                        title="Attribuer un numéro de section"
                                        className="inline-flex items-center gap-1 text-amber-500 hover:underline"
                                      >
                                        <Pencil className="h-3 w-3" />—
                                      </button>
                                    )}
                                  </span>
                                )}
                              </td>
```

This mirrors the existing checkbox cell in the same row, which already calls `e.stopPropagation()` so it doesn't trigger the row's `onClick={() => zoomToSection(s)}`.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint src/components/cadastre/SectionsClient.tsx`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, open `/cadastre/sections`, load a batch that has at least one section with no `numSection` (or check via the DB: `SELECT id FROM "limite_section" WHERE "numSection" IS NULL LIMIT 1;`).

Expected:
- The row for that section shows a pencil + "—" button instead of "—".
- Clicking it shows an input + ✓/✗ buttons, row click (zoom) doesn't fire.
- Typing a number and pressing Enter (or clicking ✓) shows a success toast and the cell now shows the plain number.
- Typing a number that already exists for another section in the same commune shows an error toast (409 message from the API) and the cell stays in edit mode.
- Escape (or ✗) cancels without calling the API.

- [ ] **Step 7: Commit**

```bash
git add src/components/cadastre/SectionsClient.tsx
git commit -m "feat(sections): inline numero attribution in the sections table"
```

---

### Task 4: Map popup edit — assign a number from the section's popup

**Files:**
- Modify: `src/components/cadastre/SectionsClient.tsx`

**Interfaces:**
- Consumes: `performSetNumero` from Task 3.
- Produces: nothing new consumed by later tasks (Task 5 only reuses `sections`/`displayedSections`, not popup internals).

- [ ] **Step 1: Add a warning to the tooltip for unnumbered sections**

Find:

```tsx
        gj.bindTooltip(
          `Section <b>${s.numSection ?? "—"}</b><br/>${s.commune ?? "—"}` +
            (hasError
              ? "<br/><span style='color:#b45309'>⚠ chevauchement à corriger — cliquer pour le sélectionner</span>"
              : "<br/><span style='opacity:.7'>cliquer : détails / supprimer</span>"),
          { sticky: true },
        );
```

Replace with:

```tsx
        gj.bindTooltip(
          `Section <b>${s.numSection ?? "—"}</b><br/>${s.commune ?? "—"}` +
            (hasError
              ? "<br/><span style='color:#b45309'>⚠ chevauchement à corriger — cliquer pour le sélectionner</span>"
              : !s.numSection
                ? "<br/><span style='color:#f59e0b'>⚠ sans numéro — cliquer pour en attribuer un</span>"
                : "<br/><span style='opacity:.7'>cliquer : détails / supprimer</span>"),
          { sticky: true },
        );
```

- [ ] **Step 2: Build the numero field in the popup when the section has none**

Find:

```tsx
        const popup = document.createElement("div");
        popup.style.cssText = "font-size:12px;min-width:170px";
        const info = document.createElement("div");
        info.innerHTML =
          `<b>Section ${escHtml(s.numSection ?? "—")}</b><br/>${escHtml(s.commune ?? "—")}` +
          (s.surfaceM2 != null
            ? `<br/>${Math.round(s.surfaceM2).toLocaleString("fr-FR")} m²`
            : "");
        const mergeBtn = document.createElement("button");
```

Replace with:

```tsx
        const popup = document.createElement("div");
        popup.style.cssText = "font-size:12px;min-width:170px";
        const info = document.createElement("div");
        info.innerHTML =
          `<b>Section ${escHtml(s.numSection ?? "—")}</b><br/>${escHtml(s.commune ?? "—")}` +
          (s.surfaceM2 != null
            ? `<br/>${Math.round(s.surfaceM2).toLocaleString("fr-FR")} m²`
            : "");
        // Section sans numéro : champ d'attribution directement dans le popup.
        let numeroWrap: HTMLDivElement | null = null;
        if (!s.numSection) {
          numeroWrap = document.createElement("div");
          numeroWrap.style.cssText = "margin-top:6px;display:flex;gap:4px";
          const numeroInput = document.createElement("input");
          numeroInput.type = "text";
          numeroInput.placeholder = "N° section";
          numeroInput.style.cssText =
            "flex:1;min-width:0;padding:3px 6px;font-size:11px;border-radius:6px;" +
            "border:1px solid #f59e0b;background:transparent;color:inherit";
          const numeroBtn = document.createElement("button");
          numeroBtn.type = "button";
          numeroBtn.textContent = "Attribuer";
          numeroBtn.style.cssText =
            "padding:3px 8px;font-size:11px;border-radius:6px;" +
            "border:1px solid #f59e0b;color:#f59e0b;background:transparent;cursor:pointer";
          const submitNumero = () => {
            const val = numeroInput.value.trim();
            if (!val) return;
            map.closePopup();
            void performSetNumero(s.id, val);
          };
          numeroBtn.onclick = submitNumero;
          numeroInput.onkeydown = (e: KeyboardEvent) => {
            if (e.key === "Enter") submitNumero();
          };
          numeroWrap.appendChild(numeroInput);
          numeroWrap.appendChild(numeroBtn);
        }
        const mergeBtn = document.createElement("button");
```

- [ ] **Step 3: Append the numero field into the popup**

Find:

```tsx
        popup.appendChild(info);
        popup.appendChild(mergeBtn);
        popup.appendChild(delBtn);
        gj.bindPopup(popup);
```

Replace with:

```tsx
        popup.appendChild(info);
        if (numeroWrap) popup.appendChild(numeroWrap);
        popup.appendChild(mergeBtn);
        popup.appendChild(delBtn);
        gj.bindPopup(popup);
```

- [ ] **Step 4: Add `performSetNumero` to the redraw effect's dependency array**

Find:

```tsx
  }, [
    sections,
    overlaps,
    pendingSectionIds,
    mapReady,
    handleDeleteSection,
    toggleMergeSelection,
  ]);
```

Replace with:

```tsx
  }, [
    sections,
    overlaps,
    pendingSectionIds,
    mapReady,
    handleDeleteSection,
    toggleMergeSelection,
    performSetNumero,
  ]);
```

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint src/components/cadastre/SectionsClient.tsx`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, open `/cadastre/sections`, click on an unnumbered section's polygon on the map.

Expected:
- Tooltip on hover shows the "⚠ sans numéro" hint.
- Popup shows an input + "Attribuer" button above the merge/delete buttons.
- Entering a number and pressing Enter (or clicking "Attribuer") closes the popup, shows a success toast, and the polygon's tooltip/table row now shows the number (no page reload needed).
- A numbered section's popup is unchanged (no numero field).

- [ ] **Step 7: Commit**

```bash
git add src/components/cadastre/SectionsClient.tsx
git commit -m "feat(sections): assign numero from the map popup"
```

---

### Task 5: "Sans numéro" filter

**Files:**
- Modify: `src/components/cadastre/SectionsClient.tsx`

**Interfaces:**
- Consumes: `sections` state, `performSetNumero`'s effect dependency chain from Task 4.
- Produces: `displayedSections` (filtered array) used by the draw effect and the table — terminal task, nothing downstream depends on it.

- [ ] **Step 1: Add the filter state**

Find:

```tsx
  const [numeroEditId, setNumeroEditId] = useState<number | null>(null);
  const [numeroDraft, setNumeroDraft] = useState("");
  const [savingNumero, setSavingNumero] = useState<number | null>(null);
  // Recadrage global : uniquement quand la PORTÉE des données change (premier
```

Replace with:

```tsx
  const [numeroEditId, setNumeroEditId] = useState<number | null>(null);
  const [numeroDraft, setNumeroDraft] = useState("");
  const [savingNumero, setSavingNumero] = useState<number | null>(null);
  // Filtre "Sans numéro" : restreint table ET carte aux sections numSection === null.
  const [showUnnumberedOnly, setShowUnnumberedOnly] = useState(false);
  // Recadrage global : uniquement quand la PORTÉE des données change (premier
```

- [ ] **Step 2: Add `unnumberedCount` and `displayedSections`**

Find:

```tsx
    } finally {
      setSavingNumero(null);
    }
  }, []);

  // ── (Re)dessin des couches sections + chevauchements ───────────────────────
  useEffect(() => {
```

Replace with:

```tsx
    } finally {
      setSavingNumero(null);
    }
  }, []);

  const unnumberedCount = useMemo(
    () => sections.filter((s) => !s.numSection).length,
    [sections],
  );
  // Sections effectivement dessinées/listées — restreintes aux non numérotées
  // quand le filtre "Sans numéro" est actif.
  const displayedSections = useMemo(
    () => (showUnnumberedOnly ? sections.filter((s) => !s.numSection) : sections),
    [sections, showUnnumberedOnly],
  );

  // ── (Re)dessin des couches sections + chevauchements ───────────────────────
  useEffect(() => {
```

- [ ] **Step 3: Draw the map layer from `displayedSections`**

Find:

```tsx
    const secGroup = L.featureGroup();
    sectionLayersRef.current.clear();
    for (const s of sections) {
      if (!s.geomGeoJson) continue;
```

Replace with:

```tsx
    const secGroup = L.featureGroup();
    sectionLayersRef.current.clear();
    for (const s of displayedSections) {
      if (!s.geomGeoJson) continue;
```

- [ ] **Step 4: Use `displayedSections` for the auto-fit check**

Find:

```tsx
    if (fitPendingRef.current && sections.length > 0) {
      fitPendingRef.current = false;
      try {
```

Replace with:

```tsx
    if (fitPendingRef.current && displayedSections.length > 0) {
      fitPendingRef.current = false;
      try {
```

- [ ] **Step 5: Update the draw effect's dependency array**

Find:

```tsx
  }, [
    sections,
    overlaps,
    pendingSectionIds,
    mapReady,
    handleDeleteSection,
    toggleMergeSelection,
    performSetNumero,
  ]);
```

Replace with:

```tsx
  }, [
    displayedSections,
    overlaps,
    pendingSectionIds,
    mapReady,
    handleDeleteSection,
    toggleMergeSelection,
    performSetNumero,
  ]);
```

- [ ] **Step 6: Update the merge-highlight effect's dependency array**

Find:

```tsx
  }, [activeMergeSelection, sections, overlaps, pendingSectionIds, mapReady]);
```

Replace with:

```tsx
  }, [activeMergeSelection, displayedSections, overlaps, pendingSectionIds, mapReady]);
```

- [ ] **Step 7: Add the filter button to the sections table header**

Find:

```tsx
                {/* Table des sections */}
                {sections.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">
                      Sections ({sections.length})
                    </h3>
```

Replace with:

```tsx
                {/* Table des sections */}
                {sections.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        Sections ({displayedSections.length}
                        {showUnnumberedOnly ? ` / ${sections.length}` : ""})
                      </h3>
                      {unnumberedCount > 0 && (
                        <button
                          onClick={() => setShowUnnumberedOnly((v) => !v)}
                          title="Afficher uniquement les sections sans numéro"
                          className={[
                            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                            showUnnumberedOnly
                              ? "bg-amber-500/20 text-amber-500"
                              : "bg-secondary text-muted-foreground hover:bg-secondary/70",
                          ].join(" ")}
                        >
                          <Pencil className="h-3 w-3" />
                          Sans numéro ({unnumberedCount})
                        </button>
                      )}
                    </div>
```

- [ ] **Step 8: Render the table body from `displayedSections`**

Find:

```tsx
                        <tbody>
                          {sections.map((s) => (
```

Replace with:

```tsx
                        <tbody>
                          {displayedSections.map((s) => (
```

- [ ] **Step 9: Type-check and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npx eslint src/components/cadastre/SectionsClient.tsx`
Expected: no errors.

- [ ] **Step 10: Manual verification**

Run: `npm run dev`, open `/cadastre/sections` on a batch with a mix of numbered and unnumbered sections.

Expected:
- The "Sans numéro (N)" button appears next to the "Sections" heading, with the correct count.
- Clicking it hides numbered sections from both the table and the map, and the heading shows `X / Y`.
- Attributing a number to a section while the filter is active makes it disappear from the filtered view immediately (its `numSection` is no longer null, so it no longer matches the filter) — this is expected, not a bug.
- Clicking the button again restores the full list.
- If a batch has zero unnumbered sections, the button doesn't appear at all.

- [ ] **Step 11: Commit**

```bash
git add src/components/cadastre/SectionsClient.tsx
git commit -m "feat(sections): add unnumbered-sections filter"
```

---

### Task 6: Documentation — `docs/CONCEPTS-TRAITEMENT-DXF.md`

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md:873-875`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by code; satisfies the project's `CLAUDE.md` rule requiring every new geometric/topological processing concept to be documented here.

- [ ] **Step 1: Insert a new "§11 ter" section before the annex**

Find (`docs/CONCEPTS-TRAITEMENT-DXF.md:869-875`):

```markdown
**Pourquoi ne PAS augmenter la tolérance.** À 2 m, la face fusionnée absorbait
aussi la section 015 : sur des tracés sans trou réel, élargir la tolérance ne
sépare rien et **dégrade** les sections voisines saines. 1 m reste le bon réglage.

---

## 12. Annexe — compteurs du rapport & variables d'environnement
```

Replace with:

```markdown
**Pourquoi ne PAS augmenter la tolérance.** À 2 m, la face fusionnée absorbait
aussi la section 015 : sur des tracés sans trou réel, élargir la tolérance ne
sépare rien et **dégrade** les sections voisines saines. 1 m reste le bon réglage.

---

## 11 ter. Attribution manuelle du numéro pour les sections sans étiquette

**Problème métier.** Une section peut sortir de l'extraction sans
`numSection` (libellé `numero_section` absent du DXF, ou hors du polygone
lors de la jointure « plus petit contenant », cf. §11) : elle reste dans
`limite_section` mais aucune fusion par numéro n'a pu s'appliquer
(§11, dissolution par (syscol, numéro)) et aucun export NICAD ne peut la
rattacher. Avant cette fonctionnalité, la seule façon de la récupérer était
la fusion manuelle avec une section déjà numérotée voisine — inutilisable
si la section est isolée et légitimement une section à part.

**Solution.** `POST /api/cadastre/sections/numero` (`{ sectionId,
numSection }`) attribue un numéro à une section dont `numSection` est
`null` — attribut seul, aucune géométrie touchée, aucun recalcul de
chevauchement. Deux points d'entrée dans `SectionsClient.tsx` : édition
inline dans la table (colonne « Sect. »), et champ dans le popup carte au
clic sur un polygone sans numéro ; un filtre « Sans numéro (N) » restreint
table et carte à ces sections pour les repérer rapidement.

**Pourquoi la vérification d'unicité est PAR COMMUNE, pas globale.** Comme
pour la dissolution (§11), un numéro de section n'est unique que **dans sa
commune** : deux communes différentes ont chacune une section « 001 ».
`findSectionNumeroConflict` (`sections-data.ts`) cherche donc une collision
sur la clé **(syscolCommune, numSection)** — la même clé que la dissolution
d'import — et non sur `numSection` seul, sinon la moitié des attributions
échouerait à tort sur des sections de communes différentes qui partagent un
numéro. Sans commune résolue (`syscolCommune` null), aucun contrôle n'est
possible : l'attribution passe sans vérification.

**Piège évité.** En cas de collision détectée, l'API refuse (409) plutôt que
de fusionner automatiquement les deux sections : une même valeur de
`numSection` dans la même commune ne veut pas nécessairement dire « même
section physique » (numérotation dupliquée par erreur dans le DXF source).
La fusion reste un geste **délibéré** de l'utilisateur via la fonction de
fusion manuelle existante (§11, « Fusion manuelle de sections »).

**Fichiers · fonctions.** `src/lib/cadastre/sections-data.ts`
(`findSectionNumeroConflict`, `updateSectionNumero`, `getSection` étendu),
`src/app/api/cadastre/sections/numero/route.ts`,
`src/components/cadastre/SectionsClient.tsx` (`performSetNumero`,
filtre `showUnnumberedOnly`).

---

## 12. Annexe — compteurs du rapport & variables d'environnement
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md
git commit -m "docs: document manual numero attribution for unnumbered sections"
```
