# Découpages groupés des chevauchements de sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre de résoudre plusieurs chevauchements de `limite_section` en une seule opération (découpe A / découpe B / auto « garder la plus petite » / ignorer en masse), au lieu d'un traitement un par un.

**Architecture:** Extraire la logique de résolution d'un chevauchement (aujourd'hui inline dans `correct/route.ts`) dans une fonction partagée `applyOverlapCorrection`, réutilisée par l'endpoint existant (inchangé pour l'utilisateur) et un nouvel endpoint `/correct-batch` qui boucle dessus séquentiellement. Le frontend ajoute une sélection multiple (checkboxes) sur la liste des chevauchements en attente et une barre d'action groupée.

**Tech Stack:** Next.js App Router (route handlers), Prisma + PostGIS (SQL brut), `@turf/turf`, React (hooks), `sonner` (toasts), TypeScript strict.

## Global Constraints

- Linter : `npx eslint <fichier>` doit être propre sur chaque fichier modifié (CLAUDE.md).
- `npx tsc --noEmit -p tsconfig.json` doit rester propre (en ignorant les erreurs préexistantes non liées : `scripts/diagnose-017-020.ts`, `.next/dev/**`).
- TypeScript strict mode — pas de `any` nouveau (le fichier a un `/* eslint-disable @typescript-eslint/no-explicit-any */` historique en tête, ne pas l'étendre pour du code neuf).
- Changements minimaux et ciblés — ne pas toucher aux actions `merge`/`delete_a`/`delete_b` individuelles (comportement inchangé), ni au flux DXF/shapefile.
- Pas de suite de tests automatisés existante pour ce module (`correct`/`merge`/`delete` n'en ont pas) — vérification par `tsc`/`eslint` + test manuel via le serveur de dev, conformément au spec (`docs/superpowers/specs/2026-07-30-decoupage-groupe-chevauchements-design.md`).
- Toute nouvelle notion de traitement géométrique/topologique (ici : la règle « auto » par comparaison d'aires, et le traitement séquentiel pour éviter les lectures de géométrie périmée) doit être documentée dans `docs/CONCEPTS-TRAITEMENT-DXF.md` (règle CLAUDE.md).

---

## Fichiers touchés

- **Créer** `src/lib/cadastre/overlap-correction.ts` — logique partagée de résolution d'UN chevauchement (extraite de `correct/route.ts`), plus la règle `"auto"` et un mapping erreur→statut HTTP.
- **Modifier** `src/app/api/cadastre/sections/correct/route.ts` — simplifié pour appeler `applyOverlapCorrection` (comportement HTTP inchangé pour l'appelant).
- **Créer** `src/app/api/cadastre/sections/correct-batch/route.ts` — nouvel endpoint, traitement séquentiel d'une liste de chevauchements.
- **Modifier** `src/components/cadastre/SectionsClient.tsx` — sélection multiple des chevauchements en attente + barre d'action groupée + `performBatchCorrection`.
- **Modifier** `docs/CONCEPTS-TRAITEMENT-DXF.md` — nouvelle entrée documentant la règle « auto » et le traitement séquentiel.

---

### Task 1: Logique de correction partagée (`overlap-correction.ts`)

**Files:**
- Create: `src/lib/cadastre/overlap-correction.ts`
- Reference (ne pas modifier dans cette tâche) : `src/app/api/cadastre/sections/correct/route.ts` (source de la logique à extraire), `src/lib/cadastre/sections-data.ts` (fonctions consommées).

**Interfaces:**
- Consomme (déjà existant, `sections-data.ts`) : `getOverlap(id): Promise<{id, sectionAId, sectionBId, sourceFichier, status} | null>`, `getSection(id): Promise<{geomGeoJson, sourceFichier, numSection} | null>`, `updateSectionGeometry(id, geom, surfaceM2): Promise<void>`, `deleteSection(id): Promise<void>`, `setOverlapStatus(id, status): Promise<void>`.
- Produit : `export type OverlapAction = "clip_a" | "clip_b" | "auto" | "merge" | "delete_a" | "delete_b" | "ignore"`, `export const OVERLAP_ACTIONS: Set<OverlapAction>`, `export async function applyOverlapCorrection(overlapId: number, action: OverlapAction): Promise<string>` (retourne le `sourceFichier` de l'overlap traité, lève une `Error` en cas d'échec), `export function statusForOverlapError(message: string): number`.

- [ ] **Step 1: Créer le fichier avec la logique extraite + l'action `auto` + le mapping de statut**

```ts
// src/lib/cadastre/overlap-correction.ts
/**
 * overlap-correction.ts — résolution d'UN chevauchement `limite_section`.
 * Logique partagée entre `correct/route.ts` (un chevauchement) et
 * `correct-batch/route.ts` (plusieurs, séquentiellement) : sortie de
 * `correct/route.ts` pour éviter de la dupliquer.
 *
 * Ne recalcule PAS les chevauchements du lot (`refreshOverlaps`) — à charge
 * de l'appelant, pour que le traitement par lot ne le fasse qu'une seule
 * fois à la fin au lieu d'une fois par chevauchement traité.
 */
import * as turf from "@turf/turf";
import {
  getOverlap,
  getSection,
  updateSectionGeometry,
  deleteSection,
  setOverlapStatus,
} from "@/lib/cadastre/sections-data";

type PolyGeom = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type OverlapAction =
  | "clip_a"
  | "clip_b"
  | "auto"
  | "merge"
  | "delete_a"
  | "delete_b"
  | "ignore";

export const OVERLAP_ACTIONS = new Set<OverlapAction>([
  "clip_a",
  "clip_b",
  "auto",
  "merge",
  "delete_a",
  "delete_b",
  "ignore",
]);

function areaM2(g: PolyGeom): number {
  try {
    return turf.area(turf.feature(g));
  } catch {
    return 0;
  }
}

/**
 * Résout un chevauchement (une action). Actions :
 *  - `clip_a` / `clip_b` : retire l'intersection de la section A (ou B) —
 *    `turf.difference` ; cible entièrement couverte → supprimée ;
 *  - `auto` : compare l'aire de A et de B (`turf.area`), découpe la plus
 *    GRANDE des deux, garde la plus petite intacte (équivalent à `clip_a`
 *    ou `clip_b` selon le cas) — à aire égale, découpe B (choix arbitraire
 *    mais déterministe) ;
 *  - `merge` : fusionne A et B (`turf.union`), B supprimée ;
 *  - `delete_a` / `delete_b` : supprime la section choisie ;
 *  - `ignore` : marque le chevauchement intentionnel (IGNORED).
 * Retourne le `sourceFichier` de l'overlap traité. Lève une `Error` si
 * l'overlap ou une section est introuvable, ou si la fusion échoue.
 */
export async function applyOverlapCorrection(
  overlapId: number,
  action: OverlapAction,
): Promise<string> {
  const ov = await getOverlap(overlapId);
  if (!ov) throw new Error("Chevauchement introuvable");

  if (action === "ignore") {
    await setOverlapStatus(overlapId, "IGNORED");
    return ov.sourceFichier;
  }

  const [a, b] = await Promise.all([getSection(ov.sectionAId), getSection(ov.sectionBId)]);
  if (!a || !b) throw new Error("Section introuvable");
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
      await deleteSection(targetId); // cible entièrement couverte
    } else {
      const g = diff.geometry as PolyGeom;
      await updateSectionGeometry(targetId, g, areaM2(g));
    }
  } else if (action === "merge") {
    const u = turf.union(turf.featureCollection([fa, fb]));
    if (!u || !u.geometry) throw new Error("Fusion impossible");
    const g = u.geometry as PolyGeom;
    await updateSectionGeometry(ov.sectionAId, g, areaM2(g));
    await deleteSection(ov.sectionBId);
  } else if (action === "delete_a") {
    await deleteSection(ov.sectionAId);
  } else if (action === "delete_b") {
    await deleteSection(ov.sectionBId);
  }

  return ov.sourceFichier;
}

/** Statut HTTP pour un message d'erreur levé par `applyOverlapCorrection` — reproduit les codes que `correct/route.ts` renvoyait avant l'extraction. */
export function statusForOverlapError(message: string): number {
  if (message === "Chevauchement introuvable" || message === "Section introuvable") return 404;
  if (message === "Fusion impossible") return 400;
  return 500;
}
```

- [ ] **Step 2: Vérifier les types et le lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "diagnose-017-020" | grep -v ".next/dev"`
Expected: aucune sortie (propre).

Run: `npx eslint src/lib/cadastre/overlap-correction.ts`
Expected: aucune sortie (propre).

- [ ] **Step 3: Vérification manuelle de la règle `auto`**

Pas de suite de tests automatisés pour ce module (cf. Global Constraints) — vérifier la logique de comparaison d'aire avec un script jetable (à supprimer après vérification, ne pas le committer) :

```bash
cat > ./__verify-auto.mjs << 'EOF'
import * as turf from "@turf/turf";
const small = turf.polygon([[[0,0],[0,1],[1,1],[1,0],[0,0]]]); // ~1 deg^2 (juste pour comparer les aires relatives)
const big = turf.polygon([[[0,0],[0,2],[2,2],[2,0],[0,0]]]);
console.log("small < big ?", turf.area(small) < turf.area(big));
EOF
node ./__verify-auto.mjs
rm ./__verify-auto.mjs
```

Expected: `small < big ? true` — confirme que `turf.area` ordonne bien les deux polygones comme attendu par la comparaison `areaM2(a) > areaM2(b)` dans `applyOverlapCorrection`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/cadastre/overlap-correction.ts
git commit -m "feat: extract shared overlap correction logic with auto-clip rule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Refactor `correct/route.ts` pour utiliser la logique partagée

**Files:**
- Modify: `src/app/api/cadastre/sections/correct/route.ts` (fichier entier remplacé — 107 lignes actuelles)

**Interfaces:**
- Consomme (Task 1) : `applyOverlapCorrection`, `OverlapAction`, `statusForOverlapError` depuis `@/lib/cadastre/overlap-correction` (PAS `OVERLAP_ACTIONS` — voir `SINGLE_CORRECT_ACTIONS` ci-dessous, ensemble restreint local à ce fichier).
- Consomme (existant) : `refreshOverlaps`, `listSections`, `listOverlaps` depuis `@/lib/cadastre/sections-data`.
- Produit : aucun changement d'interface HTTP — même body `{overlapId, action}`, mêmes réponses/statuts qu'avant (régression zéro attendue, y compris le rejet en 400 de `action: "auto"` — réservée à `correct-batch`, Task 3).

- [ ] **Step 1: Remplacer le contenu du fichier**

```ts
// src/app/api/cadastre/sections/correct/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  applyOverlapCorrection,
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
 * des actions. Renvoie les sections + chevauchements à jour du lot concerné.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

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
    const src = await applyOverlapCorrection(overlapId, action);
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

Note : le code d'origine appelait déjà `refreshOverlaps` uniquement dans la branche `else` (donc jamais pour `ignore` — aucune géométrie ne change, rien à recontrôler). Le `if (action !== "ignore")` ci-dessus reproduit fidèlement ce comportement existant, ce n'est pas un changement.

- [ ] **Step 2: Vérifier les types et le lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "diagnose-017-020" | grep -v ".next/dev"`
Expected: aucune sortie.

Run: `npx eslint src/app/api/cadastre/sections/correct/route.ts`
Expected: aucune sortie.

- [ ] **Step 3: Vérification manuelle de non-régression**

Démarrer le serveur de dev (`npm run dev`), ouvrir la page des sections, avec un lot ayant au moins un chevauchement `PENDING` :
1. Cliquer « Découper A » sur un chevauchement → vérifier que la section A est bien découpée, la carte et la liste se rafraîchissent, toast de succès.
2. Cliquer « Ignorer » sur un autre chevauchement → il disparaît de la liste `PENDING`, aucune géométrie ne change.
3. Provoquer une erreur volontaire (ex. appeler l'API avec un `overlapId` inexistant via la console navigateur `fetch("/api/cadastre/sections/correct", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({overlapId: 999999999, action: "clip_a"})})`) → vérifier une réponse `404` avec `{"error":"Chevauchement introuvable"}`.
4. Vérifier que `action: "auto"` est toujours REJETÉE par cette route (comme avant l'extraction) : `fetch("/api/cadastre/sections/correct", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({overlapId: <un id PENDING valide>, action: "auto"})})` → doit renvoyer `400 {"error":"overlapId et action valides requis"}`, PAS une correction appliquée. `"auto"` n'a de sens que comparé à un groupe (Task 3, `correct-batch`), pas ici.

Expected: comportement identique à avant l'extraction (aucune régression visible), y compris le rejet de `"auto"`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cadastre/sections/correct/route.ts
git commit -m "refactor: correct route delegates to shared overlap correction logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Nouvel endpoint `correct-batch`

**Files:**
- Create: `src/app/api/cadastre/sections/correct-batch/route.ts`

**Interfaces:**
- Consomme (Task 1) : `applyOverlapCorrection`, `OverlapAction` depuis `@/lib/cadastre/overlap-correction`.
- Consomme (existant) : `refreshOverlaps`, `listSections`, `listOverlaps` depuis `@/lib/cadastre/sections-data`.
- Produit : `POST /api/cadastre/sections/correct-batch`, body `{overlapIds: number[], action: "clip_a"|"clip_b"|"auto"|"ignore", sourceFichier?: string | null}`, réponse `{results: {overlapId: number, ok: boolean, error?: string}[], sections: SectionListItem[], overlaps: OverlapListItem[]}`.

- [ ] **Step 1: Créer le fichier**

```ts
// src/app/api/cadastre/sections/correct-batch/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { applyOverlapCorrection, type OverlapAction } from "@/lib/cadastre/overlap-correction";
import { refreshOverlaps, listSections, listOverlaps } from "@/lib/cadastre/sections-data";

export const runtime = "nodejs";

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
 * distingue réussites/échecs, pas de rollback global du lot.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  if ((session.user as { role?: string }).role !== "ADMIN") {
    return NextResponse.json({ error: "Opération réservée aux administrateurs" }, { status: 403 });
  }

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

  const results: BatchResult[] = [];
  const touchedSources = new Set<string>();
  for (const overlapId of overlapIds) {
    try {
      const src = await applyOverlapCorrection(overlapId, action);
      if (action !== "ignore") touchedSources.add(src);
      results.push({ overlapId, ok: true });
    } catch (err) {
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

- [ ] **Step 2: Vérifier les types et le lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "diagnose-017-020" | grep -v ".next/dev"`
Expected: aucune sortie.

Run: `npx eslint src/app/api/cadastre/sections/correct-batch/route.ts`
Expected: aucune sortie.

- [ ] **Step 3: Vérification manuelle via curl/console navigateur**

Avec un lot ayant au moins 2 chevauchements `PENDING` (récupérer leurs `id` via `GET /api/cadastre/sections/overlaps?sourceFichier=...` ou l'onglet réseau du navigateur), depuis la console du navigateur sur la page (pour réutiliser le cookie de session ADMIN) :

```js
fetch("/api/cadastre/sections/correct-batch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ overlapIds: [ID1, ID2], action: "auto" }),
}).then(r => r.json()).then(console.log);
```

Expected: `{ results: [{overlapId: ID1, ok: true}, {overlapId: ID2, ok: true}], sections: [...], overlaps: [...] }` — les deux sections concernées sont découpées (vérifier en rechargeant la page que les chevauchements ID1/ID2 ont disparu de la liste `PENDING`).

Puis tester le cas d'échec partiel : répéter le même appel avec un `overlapId` déjà résolu (donc absent de la table) mélangé à un `overlapId` valide → vérifier `results` contient bien un `ok: false` avec `error: "Chevauchement introuvable"` pour celui déjà résolu, et `ok: true` pour l'autre (le traitement n'est pas bloqué).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cadastre/sections/correct-batch/route.ts
git commit -m "feat: add batch endpoint for grouped overlap corrections

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Sélection multiple des chevauchements (frontend)

**Files:**
- Modify: `src/components/cadastre/SectionsClient.tsx:179` (ajout d'états après `merging`), `:457` (ajout d'un toggle après `toggleMergeSelection`), `:1011` (ajout de la sélection active après `pending`), `:1373-1402` (checkbox par ligne + checkbox « tout sélectionner »)

**Interfaces:**
- Produit : `overlapSelection: number[]` (state), `toggleOverlapSelection(id: number): void`, `activeOverlapSelection: number[]` (dérivé, restreint aux chevauchements encore `PENDING`) — consommés par Task 5.

- [ ] **Step 1: Ajouter l'état de sélection**

Dans `src/components/cadastre/SectionsClient.tsx`, juste après la ligne `const [merging, setMerging] = useState(false);` (ligne 179) :

```tsx
  // Sélection multiple de chevauchements pour un traitement groupé (découpe
  // A/B, auto, ignorer) — même principe que `mergeSelection` mais restreinte
  // aux chevauchements PENDING (voir `activeOverlapSelection` plus bas).
  const [overlapSelection, setOverlapSelection] = useState<number[]>([]);
  const [batchCorrecting, setBatchCorrecting] = useState(false);
```

- [ ] **Step 2: Ajouter le toggle**

Juste après le bloc `toggleMergeSelection` (après la ligne `}, []);` qui suit sa définition, ligne ~457) :

```tsx
  const toggleOverlapSelection = useCallback((id: number) => {
    setOverlapSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);
```

- [ ] **Step 3: Ajouter la sélection active (restreinte aux PENDING)**

Juste après `const pending = overlaps.filter((o) => o.status === "PENDING");` (ligne 1011, avant le `return`) :

```tsx
  // Sélection restreinte aux chevauchements encore PENDING affichés : les ids
  // résolus (correction individuelle, changement de lot) deviennent inertes
  // sans setState d'effet — même principe que `activeMergeSelection`.
  const activeOverlapSelection = overlapSelection.filter((id) =>
    pending.some((o) => o.id === id),
  );
```

- [ ] **Step 4: Ajouter les checkboxes dans la liste des chevauchements**

Repérer le bloc (vers la ligne 1371-1402, juste avant `{pending.map((o) => {`) et juste après l'ouverture `<div className="space-y-2">` :

```tsx
                    <div className="space-y-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={
                            pending.length > 0 &&
                            activeOverlapSelection.length === pending.length
                          }
                          ref={(el) => {
                            if (el) {
                              el.indeterminate =
                                activeOverlapSelection.length > 0 &&
                                activeOverlapSelection.length < pending.length;
                            }
                          }}
                          onChange={() =>
                            setOverlapSelection(
                              activeOverlapSelection.length === pending.length
                                ? []
                                : pending.map((o) => o.id),
                            )
                          }
                          className="h-3 w-3 cursor-pointer accent-red-500"
                        />
                        Tout sélectionner ({pending.length})
                      </label>
                      {pending.map((o) => {
```

(Le `{pending.map((o) => {` existant est réutilisé tel quel — seule la ligne `<label>` est insérée avant, et le `<div className="space-y-2">` d'origine n'est pas dupliqué.)

Puis, dans le bloc de chaque carte de chevauchement, juste avant `<AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />` (ligne ~1392) :

```tsx
                              <input
                                type="checkbox"
                                checked={activeOverlapSelection.includes(o.id)}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleOverlapSelection(o.id)}
                                title="Sélectionner pour traitement groupé"
                                className="h-3 w-3 shrink-0 cursor-pointer accent-red-500"
                              />
```

- [ ] **Step 5: Vérifier les types et le lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "diagnose-017-020" | grep -v ".next/dev"`
Expected: aucune sortie.

Run: `npx eslint src/components/cadastre/SectionsClient.tsx`
Expected: aucune sortie (avertissements préexistants du fichier, s'il y en a, inchangés).

- [ ] **Step 6: Vérification manuelle**

`npm run dev`, ouvrir la page sections avec un lot ayant plusieurs chevauchements `PENDING`. Cocher deux chevauchements individuellement → vérifier l'état visuel des cases. Cocher « Tout sélectionner » → toutes les cases se cochent, la case d'en-tête devient pleine (pas indéterminée). Décocher un chevauchement → la case d'en-tête passe à l'état indéterminé (trait, pas coché).

- [ ] **Step 7: Commit**

```bash
git add src/components/cadastre/SectionsClient.tsx
git commit -m "feat: add multi-select checkboxes for pending overlaps

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Barre d'action groupée + appel batch (frontend)

**Files:**
- Modify: `src/components/cadastre/SectionsClient.tsx` (ajout de `performBatchCorrection`/`confirmBatchCorrection` près de `performCorrection`/`applyCorrection`, ligne ~817-901 ; ajout de la barre d'action dans le JSX, juste après le `<label>` « Tout sélectionner » ajouté en Task 4)

**Interfaces:**
- Consomme (Task 4) : `activeOverlapSelection: number[]`, `setOverlapSelection`, `batchCorrecting: boolean`, `setBatchCorrecting`.
- Consomme (existant) : `confirmState`/`setConfirmState` (dialogue de confirmation partagé), `sourceFichier`, `setSections`, `setOverlaps`, `fetchData`, `toast` (sonner), `ActBtn` (composant local en bas de fichier).
- Consomme (Task 3, implicitement via HTTP) : `POST /api/cadastre/sections/correct-batch`.

- [ ] **Step 1: Ajouter `performBatchCorrection` et `confirmBatchCorrection`**

Ces deux fonctions référencent `activeOverlapSelection` (déclaré en Task 4
Step 3, juste avant le `return`, ligne ~1011) — les insérer **juste après
cette déclaration**, pas près de `applyCorrection` (ligne ~901, plus haut
dans le fichier) : `activeOverlapSelection` est un `const` non hissé, y
référer avant son initialisation (dans le tableau de dépendances d'un
`useCallback` évalué plus tôt dans le rendu) lèverait une `ReferenceError`
(TDZ) à l'exécution.

```tsx
  const pending = overlaps.filter((o) => o.status === "PENDING");

  // Sélection restreinte aux chevauchements encore PENDING affichés : les ids
  // résolus (correction individuelle, changement de lot) deviennent inertes
  // sans setState d'effet — même principe que `activeMergeSelection`.
  const activeOverlapSelection = overlapSelection.filter((id) =>
    pending.some((o) => o.id === id),
  );
```
(bloc déjà ajouté en Task 4 Step 3 — reproduit ici comme repère, ne pas le
dupliquer) puis, directement à la suite :

```tsx
  // ── Application groupée d'une règle sur plusieurs chevauchements ───────────
  const performBatchCorrection = useCallback(
    async (ids: number[], action: "clip_a" | "clip_b" | "auto" | "ignore") => {
      setBatchCorrecting(true);
      try {
        const res = await fetch("/api/cadastre/sections/correct-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overlapIds: ids, action, sourceFichier }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Correction groupée échouée");
        setSections(data.sections ?? []);
        setOverlaps(data.overlaps ?? []);
        setOverlapSelection([]);
        const results: Array<{ overlapId: number; ok: boolean; error?: string }> =
          data.results ?? [];
        const nbOk = results.filter((r) => r.ok).length;
        const nbFail = results.length - nbOk;
        if (nbFail === 0) {
          toast.success(
            `${nbOk} correction${nbOk > 1 ? "s" : ""} appliquée${nbOk > 1 ? "s" : ""}.`,
          );
        } else {
          toast.warning(
            `${nbOk} correction${nbOk > 1 ? "s" : ""} appliquée${nbOk > 1 ? "s" : ""}, ${nbFail} échouée${nbFail > 1 ? "s" : ""}.`,
          );
          console.warn(
            "[correct-batch] échecs :",
            results.filter((r) => !r.ok),
          );
        }
      } catch (err) {
        toast.error(String(err));
      } finally {
        setBatchCorrecting(false);
      }
    },
    [sourceFichier],
  );

  const BATCH_ACTION_LABELS = {
    clip_a: "Découper la section A",
    clip_b: "Découper la section B",
    auto: "Découper automatiquement (garder la plus petite section)",
    ignore: "Ignorer",
  } as const;

  const confirmBatchCorrection = useCallback(
    (action: "clip_a" | "clip_b" | "auto" | "ignore") => {
      const ids = activeOverlapSelection;
      if (ids.length === 0) return;
      const label = BATCH_ACTION_LABELS[action];
      if (action === "ignore") {
        setConfirmState({
          title: "Ignorer les chevauchements sélectionnés",
          description: `Marquer ${ids.length} chevauchement(s) comme intentionnel(s) — ils ne seront plus listés comme erreur.`,
          confirmLabel: "Ignorer",
          run: () => void performBatchCorrection(ids, action),
        });
        return;
      }
      setConfirmState({
        title: label,
        description: `${label} sur ${ids.length} chevauchement(s) sélectionné(s).\nCette action est irréversible.`,
        confirmLabel: "Appliquer",
        run: () => void performBatchCorrection(ids, action),
      });
    },
    [activeOverlapSelection, performBatchCorrection],
  );
```

- [ ] **Step 2: Ajouter la barre d'action groupée dans le JSX**

Juste après le `<label>` « Tout sélectionner » ajouté en Task 4 Step 4, avant `{pending.map((o) => {` :

```tsx
                      {activeOverlapSelection.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-500/5 p-2">
                          <span className="text-[11px] font-medium">
                            {activeOverlapSelection.length} sélectionné
                            {activeOverlapSelection.length > 1 ? "s" : ""}
                          </span>
                          <div className="ml-auto flex flex-wrap gap-1">
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("clip_a")}
                              icon={<Scissors className="h-3 w-3" />}
                            >
                              Découper A
                            </ActBtn>
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("clip_b")}
                              icon={<Scissors className="h-3 w-3" />}
                            >
                              Découper B
                            </ActBtn>
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("auto")}
                              icon={<Scissors className="h-3 w-3" />}
                            >
                              Auto (+ petite)
                            </ActBtn>
                            <ActBtn
                              busy={batchCorrecting}
                              onClick={() => confirmBatchCorrection("ignore")}
                              icon={<EyeOff className="h-3 w-3" />}
                            >
                              Ignorer
                            </ActBtn>
                            <button
                              onClick={() => setOverlapSelection([])}
                              disabled={batchCorrecting}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
                              title="Annuler la sélection"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )}
```

- [ ] **Step 3: Vérifier les types et le lint**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "diagnose-017-020" | grep -v ".next/dev"`
Expected: aucune sortie.

Run: `npx eslint src/components/cadastre/SectionsClient.tsx`
Expected: aucune sortie.

- [ ] **Step 4: Vérification manuelle end-to-end**

`npm run dev`, page sections avec un lot ayant ≥ 3 chevauchements `PENDING` :
1. Sélectionner 2 chevauchements → la barre d'action apparaît avec le bon compte.
2. Cliquer « Auto (+ petite) » → dialogue de confirmation avec le bon message et le bon nombre → confirmer → toast `"2 corrections appliquées."`, les 2 chevauchements disparaissent de la liste, la carte se rafraîchit. Vérifier dans la table des sections que c'est bien la section la plus GRANDE des deux qui a été rognée (surface réduite) et la plus petite qui reste intacte.
3. Sélectionner 2 chevauchements dont un partage une section avec l'autre (si le jeu de données le permet) → « Découper A » → vérifier le toast en cas d'échec partiel (`"1 correction appliquée, 1 échouée."`) et que la correction réussie est bien appliquée malgré l'échec de l'autre.
4. Cliquer « Tout sélectionner » puis « Ignorer » → tous les chevauchements du lot disparaissent de `PENDING` (statut `IGNORED`), aucune géométrie ne change (vérifier les surfaces des sections avant/après dans la table).

- [ ] **Step 5: Commit**

```bash
git add src/components/cadastre/SectionsClient.tsx
git commit -m "feat: add grouped overlap correction action bar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation du concept + vérification finale globale

**Files:**
- Modify: `docs/CONCEPTS-TRAITEMENT-DXF.md` (nouvelle entrée)

**Interfaces:** aucune (documentation uniquement).

- [ ] **Step 1: Lire la structure actuelle du fichier pour insérer au bon endroit**

Run: `grep -n "^## \|^### " docs/CONCEPTS-TRAITEMENT-DXF.md | tail -20`

Repérer la dernière section liée aux chevauchements/sections (probablement la section overlap/dissolution la plus récente) et insérer la nouvelle entrée juste après, en cohérence avec le sommaire du fichier (mettre à jour aussi la table des matières en tête de fichier si elle liste les sections par numéro, comme fait pour les entrées « §11 bis »/« §11 ter » précédentes).

- [ ] **Step 2: Ajouter l'entrée**

Ajouter une section (numérotée à la suite de la dernière existante, ex. si la dernière est `§12`, celle-ci devient `§13`) :

```markdown
## §N. Correction groupée des chevauchements de sections : règle « auto » et ordre séquentiel

**Problème métier** : résoudre les chevauchements de `limite_section` un par
un (découper/fusionner/supprimer) est lent quand un lot en contient des
dizaines. Il faut pouvoir appliquer la même règle à plusieurs chevauchements
en une fois, sans dupliquer la logique de résolution ni casser un
chevauchement au profit d'un autre traité juste avant dans le même lot.

**Cause technique** : deux pièges distincts pour un traitement en masse
d'objets géométriques qui peuvent se chevaucher les uns les autres :
1. Une règle « garder la plus petite section » ne peut pas être décidée une
   fois pour toutes à l'avance : elle dépend de l'aire de CHAQUE paire
   (`turf.area`), recalculée au moment de traiter CE chevauchement précis —
   pas un tri global des sections par taille en amont.
2. Un traitement **parallèle** (`Promise.all`) de plusieurs corrections est
   dangereux dès que deux chevauchements du même lot partagent une section :
   corriger le premier modifie la géométrie de cette section en base : si le
   second lit sa version AVANT cette modification (ce qu'un traitement
   parallèle ferait), il calcule une découpe sur une géométrie déjà périmée.

**Solution** (`src/lib/cadastre/overlap-correction.ts` ·
`applyOverlapCorrection`, `src/app/api/cadastre/sections/correct-batch/route.ts`) :
- La règle `"auto"` compare `turf.area(a.geomGeoJson)` et
  `turf.area(b.geomGeoJson)` **au moment de traiter ce chevauchement précis**
  (les deux sections sont rechargées depuis la base via `getSection`, pas
  passées en paramètre depuis un calcul antérieur) — découpe systématiquement
  la plus grande, garde la plus petite intacte (à aire égale, découpe B).
- Le traitement par lot boucle **séquentiellement** (`for...of`, pas
  `Promise.all`) sur la liste de chevauchements : chaque itération relit les
  sections depuis la base, donc voit forcément l'état laissé par l'itération
  précédente du même lot.
- `refreshOverlaps` (recalcul des chevauchements du lot) n'est appelé
  **qu'une seule fois à la fin**, pour chaque `sourceFichier` distinct
  effectivement modifié — pas une fois par chevauchement traité (coûteux et
  inutile, l'état intermédiaire entre deux corrections du même lot n'a pas
  besoin d'être recalculé).

**Pourquoi (pièges inclus)** : un chevauchement déjà résolu par un item
précédent du même lot (section supprimée car entièrement couverte) fait
échouer proprement l'item suivant qui la référencerait encore
(`"Section introuvable"`) — accepté par design (pas de rollback global, cf.
`docs/superpowers/specs/2026-07-30-decoupage-groupe-chevauchements-design.md`) :
le rapport `results[]` distingue réussites/échecs plutôt que de bloquer tout
le lot pour un seul cas déjà résolu par ailleurs.
```

- [ ] **Step 3: Mettre à jour le sommaire/table des matières si présent**

Si le fichier a une table des matières en tête (vérifier avec `grep -n "^\[" docs/CONCEPTS-TRAITEMENT-DXF.md` ou `grep -n "Sommaire\|Table des matières" docs/CONCEPTS-TRAITEMENT-DXF.md`), y ajouter l'entrée correspondant à la nouvelle section, avec le même format que les entrées existantes.

- [ ] **Step 4: Commit la documentation**

```bash
git add docs/CONCEPTS-TRAITEMENT-DXF.md
git commit -m "docs: document grouped overlap correction auto-rule and sequencing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Vérification finale globale**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "diagnose-017-020" | grep -v ".next/dev"`
Expected: aucune sortie.

Run: `npx eslint src/lib/cadastre/overlap-correction.ts src/app/api/cadastre/sections/correct/route.ts src/app/api/cadastre/sections/correct-batch/route.ts src/components/cadastre/SectionsClient.tsx`
Expected: aucune sortie (ou uniquement des avertissements préexistants sans lien avec ce travail).

Run: `git status --short`
Expected : uniquement les fichiers de ce plan modifiés/créés, aucun fichier temporaire de vérification (`__verify-auto.mjs` etc.) laissé derrière.
