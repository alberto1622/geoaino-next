# Guide interactif d'onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un tour interactif (spotlight sur la vraie UI, via `react-joyride`) qui présente les grandes zones de l'application au premier login, et reste rejouable à tout moment via un bouton « Aide » dans la `NavBar`.

**Architecture:** Un champ `onboardingVuLe` sur `User` (Prisma) persiste l'état vu/pas-vu. Deux Server Actions (`getOnboardingStatus`, `marquerOnboardingVu`) exposent/écrivent cet état. Un composant client `OnboardingTour` encapsule `react-joyride`, monté une seule fois à l'intérieur de `NavBar` (rendue sur toutes les pages authentifiées) — il cible par attribut `data-tour` les vrais liens du menu desktop, déjà tous visibles simultanément sur une même page, sans navigation entre routes pendant le tour.

**Tech Stack:** Next.js App Router, React 19 (client component), Prisma/PostgreSQL, `react-joyride` v3.2.0 (nouvelle dépendance, peer deps React 16.8–19 — compatible), NextAuth (`requireUserId`).

**Spec:** `docs/superpowers/specs/2026-09-22-onboarding-guide-design.md`

## Global Constraints

- Librairie de tour : `react-joyride` (pas `driver.js`) — API contrôlée idiomatique React, compatible React 19.
- Un seul point de montage du tour : à l'intérieur de `NavBar.tsx` (jamais dans un layout séparé ni dans les ~10 sites d'appel de `<NavBar>` — aucun de ces sites n'a besoin d'être modifié).
- Persistance en base (`onboardingVuLe DateTime?` sur `User`), pas de `localStorage`.
- Périmètre v1 : vue d'ensemble générale uniquement (7 étapes définies dans la spec) — aucune aide contextuelle par page.
- Ce projet n'a **aucun framework de test automatisé** (vérifié : ni `jest`/`vitest` dans `package.json`, ni fichier `*.test.ts`). La vérification de chaque tâche suit donc la convention déjà établie dans ce dépôt : `npx tsc --noEmit` + `npx eslint <fichiers>` pour la correction statique, complétés par une vérification manuelle/scriptée concrète décrite dans chaque tâche (pas de tests unitaires inventés pour l'occasion).
- Couleurs de l'UI du tour via les variables CSS du design system existant (`var(--card)`, `var(--card-foreground)`, `var(--primary)`) — jamais de couleurs en dur, pour s'adapter automatiquement au thème clair/sombre.
- Tous les textes utilisateur en français.

---

## Task 1: Migration Prisma — champ `onboardingVuLe` sur `User`

**Files:**
- Modify: `prisma/schema.prisma:63` (bloc `model User`)
- Create (généré automatiquement) : `prisma/migrations/<timestamp>_add_onboarding_vu/migration.sql`

**Interfaces:**
- Produces: colonne `"onboardingVuLe"` (type `TIMESTAMP(3)`, nullable) sur la table `"User"` — consommée par les Server Actions de la Task 2 via `prisma.user.findUnique`/`updateMany`.

- [ ] **Step 1: Ajouter le champ au modèle Prisma**

Dans `prisma/schema.prisma`, le bloc `model User` est actuellement :

```prisma
model User {
  id            String    @id @default(cuid())
  name          String?
  email         String?   @unique
  emailVerified DateTime?
  image         String?
  password      String?
  role          Role      @default(USER)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  lastSignedIn  DateTime  @default(now())

  accounts         Account[]
  sessions         Session[]
  analyses         Analysis[]
  reports          Report[]
  adminLayers      AdminLayer[]
  aiConversations  AiConversation[]
}
```

Remplacer par (ajout d'une seule ligne, `onboardingVuLe`, juste après `lastSignedIn`) :

```prisma
model User {
  id            String    @id @default(cuid())
  name          String?
  email         String?   @unique
  emailVerified DateTime?
  image         String?
  password      String?
  role          Role      @default(USER)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  lastSignedIn  DateTime  @default(now())
  onboardingVuLe DateTime?

  accounts         Account[]
  sessions         Session[]
  analyses         Analysis[]
  reports          Report[]
  adminLayers      AdminLayer[]
  aiConversations  AiConversation[]
}
```

- [ ] **Step 2: Vérifier que Postgres tourne**

Run: `docker ps --filter "name=geoaino_postgres" --format "{{.Names}}\t{{.Status}}"`
Expected: une ligne `geoaino_postgres   Up ...`. Si absent, lancer :
`docker-compose --project-name geoaino-next up -d postgres` (commande exacte requise dans cet environnement — une commande `docker-compose up` seule depuis un mauvais dossier recrée un volume vide).

- [ ] **Step 3: Générer et appliquer la migration**

Run: `npx prisma migrate dev --name add_onboarding_vu`
Expected: sortie se terminant par `Your database is now in sync with your schema.` et un nouveau dossier `prisma/migrations/<timestamp>_add_onboarding_vu/` créé. Le client Prisma est régénéré automatiquement par cette commande.

- [ ] **Step 4: Vérifier la colonne en base**

Run: `docker exec geoaino_postgres psql -U postgres -d geoaino_db -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'onboardingVuLe';"`
Expected:
```
   column_name   |            data_type            | is_nullable
------------------+----------------------------------+-------------
 onboardingVuLe   | timestamp without time zone       | YES
```

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): ajouter onboardingVuLe sur User (guide interactif)"
```

---

## Task 2: Server Actions `getOnboardingStatus` / `marquerOnboardingVu`

**Files:**
- Create: `src/app/_actions/onboarding.ts`

**Interfaces:**
- Consumes: `requireUserId(): Promise<string>` (depuis `@/lib/auth-guards`, garde existante — lève une erreur si non authentifié) ; `prisma` (singleton, `@/lib/prisma`) ; colonne `onboardingVuLe` produite par la Task 1.
- Produces: `getOnboardingStatus(): Promise<{ vu: boolean }>` et `marquerOnboardingVu(): Promise<void>` — consommées par `OnboardingTour` (Task 3).

- [ ] **Step 1: Créer le fichier de Server Actions**

Créer `src/app/_actions/onboarding.ts` avec exactement ce contenu :

```ts
"use server";

import { requireUserId } from "@/lib/auth-guards";
import { prisma } from "@/lib/prisma";

export async function getOnboardingStatus(): Promise<{ vu: boolean }> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboardingVuLe: true },
  });
  return { vu: !!user?.onboardingVuLe };
}

export async function marquerOnboardingVu(): Promise<void> {
  const userId = await requireUserId();
  // Idempotent : n'écrase jamais une date déjà posée (ne réinitialise pas
  // le tour à une reconnexion suivante si déjà marqué vu).
  await prisma.user.updateMany({
    where: { id: userId, onboardingVuLe: null },
    data: { onboardingVuLe: new Date() },
  });
}
```

- [ ] **Step 2: Vérifier la compilation TypeScript**

Run: `npx tsc --noEmit -p .`
Expected: aucune sortie (aucune erreur). Le module `@prisma/client` régénéré à la Task 1 doit exposer `onboardingVuLe` sur le type `User` — une erreur ici indiquerait que la Task 1 n'a pas régénéré le client (relancer `npx prisma generate`).

- [ ] **Step 3: Vérifier le lint**

Run: `npx eslint src/app/_actions/onboarding.ts`
Expected: aucune sortie (aucune erreur/avertissement).

- [ ] **Step 4: Commit**

```bash
git add src/app/_actions/onboarding.ts
git commit -m "feat(onboarding): server actions getOnboardingStatus/marquerOnboardingVu"
```

---

## Task 3: Dépendance `react-joyride` + composant `OnboardingTour`

**Files:**
- Modify: `package.json` (nouvelle dépendance)
- Create: `src/components/OnboardingTour.tsx`

**Interfaces:**
- Consumes: `getOnboardingStatus`/`marquerOnboardingVu` (Task 2, `@/app/_actions/onboarding`) ; cibles DOM `data-tour="nav-dashboard"`, `data-tour="nav-cadastre"`, `data-tour="nav-history"`, `data-tour="nav-reports"`, `data-tour="nav-admin-users"`, `data-tour="nav-aide"` (produites par la Task 4, `NavBar.tsx`) — ce composant peut être écrit et type-vérifié AVANT la Task 4, les cibles n'ont besoin d'exister qu'à l'exécution (`react-joyride` gère nativement une cible absente, cf. spec).
- Produces: composant `OnboardingTour({ role, run, setRun }: { role?: string | null; run: boolean; setRun: (run: boolean) => void })` — consommé par `NavBar.tsx` (Task 4).

- [ ] **Step 1: Installer la dépendance**

Run: `npm install react-joyride@^3.2.0`
Expected: `package.json`/`package-lock.json` modifiés, `"react-joyride": "^3.2.0"` dans `dependencies`. Aucun avertissement de peer dependency (React 19.2.4 du projet est dans la plage supportée `16.8 - 19`).

- [ ] **Step 2: Créer le composant**

Créer `src/components/OnboardingTour.tsx` avec exactement ce contenu :

```tsx
"use client";

import { useEffect, useMemo } from "react";
import Joyride, { STATUS, type CallBackProps, type Step } from "react-joyride";
import { getOnboardingStatus, marquerOnboardingVu } from "@/app/_actions/onboarding";

interface OnboardingTourProps {
  role?: string | null;
  run: boolean;
  setRun: (run: boolean) => void;
}

export function OnboardingTour({ role, run, setRun }: OnboardingTourProps) {
  // Vérifie une seule fois, au montage, si l'utilisateur a déjà vu le
  // guide — lance automatiquement le tour si non. Échec (session expirée,
  // réseau) volontairement ignoré : pas de blocage, l'utilisateur garde
  // le bouton « Aide » pour le lancer manuellement.
  useEffect(() => {
    let cancelled = false;
    getOnboardingStatus()
      .then(({ vu }) => {
        if (!cancelled && !vu) setRun(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = useMemo<Step[]>(() => {
    const base: Step[] = [
      {
        target: "body",
        placement: "center",
        title: "Bienvenue sur GéoAino",
        content:
          "Détection des erreurs topologiques, correction et rapports d'analyse des données cadastrales du Sénégal. Ce guide vous présente rapidement les grandes zones de l'application.",
        disableBeacon: true,
      },
      {
        target: '[data-tour="nav-dashboard"]',
        content: "Le tableau de bord : vue d'ensemble de vos imports et analyses.",
      },
      {
        target: '[data-tour="nav-cadastre"]',
        content:
          "Le module Cadastre : basculement NICAD 2013 → 2026, migration en masse, gestion des sections, import DXF/shapefile.",
      },
      {
        target: '[data-tour="nav-history"]',
        content: "L'historique : la traçabilité de toutes les actions effectuées.",
      },
      {
        target: '[data-tour="nav-reports"]',
        content: "Les rapports : consultation et export des résultats d'analyse.",
      },
    ];
    if (role === "ADMIN") {
      base.push({
        target: '[data-tour="nav-admin-users"]',
        content: "Gestion des utilisateurs et de leurs rôles.",
      });
    }
    base.push({
      target: '[data-tour="nav-aide"]',
      content: "Vous pouvez revoir ce guide à tout moment ici.",
    });
    return base;
  }, [role]);

  function handleCallback(data: CallBackProps) {
    const { status } = data;
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      setRun(false);
      // Échec sans conséquence grave : le tour se relancera simplement à
      // la prochaine connexion si l'écriture n'a pas abouti.
      marquerOnboardingVu().catch(() => {});
    }
  }

  return (
    <Joyride
      steps={steps}
      run={run}
      continuous
      showProgress
      showSkipButton
      scrollToFirstStep
      callback={handleCallback}
      locale={{
        back: "Précédent",
        close: "Fermer",
        last: "Terminer",
        next: "Suivant",
        nextLabelWithProgress: "Suivant (étape {step} sur {steps})",
        open: "Ouvrir le guide",
        skip: "Passer",
      }}
      styles={{
        options: {
          arrowColor: "var(--card)",
          backgroundColor: "var(--card)",
          overlayColor: "rgba(0, 0, 0, 0.5)",
          primaryColor: "var(--primary)",
          textColor: "var(--card-foreground)",
          zIndex: 10000,
        },
      }}
    />
  );
}
```

- [ ] **Step 3: Vérifier la compilation TypeScript**

Run: `npx tsc --noEmit -p .`
Expected: aucune sortie.

- [ ] **Step 4: Vérifier le lint**

Run: `npx eslint src/components/OnboardingTour.tsx`
Expected: aucune sortie.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/components/OnboardingTour.tsx
git commit -m "feat(onboarding): composant OnboardingTour (react-joyride)"
```

---

## Task 4: Brancher le tour dans `NavBar.tsx`

**Files:**
- Modify: `src/components/NavBar.tsx` (fichier complet, 151 lignes actuelles)

**Interfaces:**
- Consumes: `OnboardingTour` (Task 3, `@/components/OnboardingTour`).
- Produces: attributs `data-tour="nav-dashboard"|"nav-cadastre"|"nav-history"|"nav-reports"|"nav-admin-users"|"nav-aide"` sur les éléments réels du DOM — cibles consommées par `OnboardingTour` (Task 3) à l'exécution.

Le fichier actuel `src/components/NavBar.tsx` est :

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart2,
  History,
  FileText,
  // MapPin,
  LogOut,
  LogIn,
  Landmark,
  Users,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
} from "@/components/ui/sheet";
// import { ThemeToggle } from "@/components/ThemeToggle";
import { signOutAction } from "@/app/_actions/auth";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";

interface NavBarProps {
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}

const NAV_LINKS = [
  { label: "Tableau de bord", href: "/dashboard", icon: BarChart2 },
  { label: "Cadastre", href: "/cadastre/dashboard", icon: Landmark },
  { label: "Historique", href: "/history", icon: History },
  { label: "Rapports", href: "/reports", icon: FileText },
];

export function NavBar({ user }: NavBarProps) {
  const pathname = usePathname();
  const links =
    user?.role === "ADMIN"
      ? [
          ...NAV_LINKS,
          { label: "Utilisateurs", href: "/admin/utilisateurs", icon: Users },
        ]
      : NAV_LINKS;

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Navigation mobile : les liens sont masqués sous md, un drawer les remplace. */}
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Ouvrir le menu de navigation"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" title="Navigation">
              <nav className="flex flex-col gap-1">
                {links.map(({ label, href, icon: Icon }) => (
                  <SheetClose asChild key={href}>
                    <Link
                      href={href}
                      aria-current={pathname === href ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all",
                        pathname === href
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </Link>
                  </SheetClose>
                ))}
              </nav>
            </SheetContent>
          </Sheet>

          <Link
            href="/"
            className="flex items-center"
            aria-label="GEO-AINO SUPREME — accueil"
          >
            <Logo className="h-12 sm:h-13" priority />
          </Link>
        </div>

        <nav className="hidden md:flex items-center gap-1">
          {links.map(({ label, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-all",
                pathname === href
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* <ThemeToggle />
          <Link href="/map">
            <Button size="sm" className="gap-2 shadow-lg shadow-primary/20">
              <MapPin className="w-4 h-4" />
              Carte
            </Button>
          </Link> */}
          {user ? (
            <form action={signOutAction}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2"
                title="Se déconnecter"
              >
                <LogOut className="w-4 h-4" />
                {user.name || user.email}
              </Button>
            </form>
          ) : (
            <Link href="/login">
              <Button variant="ghost" size="sm" className="gap-2">
                <LogIn className="w-4 h-4" />
                Connexion
              </Button>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 1: Remplacer le fichier entier**

Remplacer TOUT le contenu de `src/components/NavBar.tsx` par exactement ceci (six changements par rapport à la version ci-dessus : import `useState`, import `HelpCircle`, import `OnboardingTour`, `tourId` sur chaque entrée de `NAV_LINKS` et sur l'entrée admin, état `tourRun`, `data-tour` sur le `<Link>` du menu desktop, bouton « Aide » + rendu de `OnboardingTour`) :

```tsx
"use client";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  BarChart2,
  History,
  FileText,
  // MapPin,
  LogOut,
  LogIn,
  Landmark,
  Users,
  Menu,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
} from "@/components/ui/sheet";
// import { ThemeToggle } from "@/components/ThemeToggle";
import { signOutAction } from "@/app/_actions/auth";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { OnboardingTour } from "@/components/OnboardingTour";

interface NavBarProps {
  user?: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}

const NAV_LINKS = [
  { label: "Tableau de bord", href: "/dashboard", icon: BarChart2, tourId: "nav-dashboard" },
  { label: "Cadastre", href: "/cadastre/dashboard", icon: Landmark, tourId: "nav-cadastre" },
  { label: "Historique", href: "/history", icon: History, tourId: "nav-history" },
  { label: "Rapports", href: "/reports", icon: FileText, tourId: "nav-reports" },
];

export function NavBar({ user }: NavBarProps) {
  const pathname = usePathname();
  const [tourRun, setTourRun] = useState(false);
  const links =
    user?.role === "ADMIN"
      ? [
          ...NAV_LINKS,
          { label: "Utilisateurs", href: "/admin/utilisateurs", icon: Users, tourId: "nav-admin-users" },
        ]
      : NAV_LINKS;

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Navigation mobile : les liens sont masqués sous md, un drawer les remplace. */}
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Ouvrir le menu de navigation"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" title="Navigation">
              <nav className="flex flex-col gap-1">
                {links.map(({ label, href, icon: Icon }) => (
                  <SheetClose asChild key={href}>
                    <Link
                      href={href}
                      aria-current={pathname === href ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all",
                        pathname === href
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </Link>
                  </SheetClose>
                ))}
              </nav>
            </SheetContent>
          </Sheet>

          <Link
            href="/"
            className="flex items-center"
            aria-label="GEO-AINO SUPREME — accueil"
          >
            <Logo className="h-12 sm:h-13" priority />
          </Link>
        </div>

        <nav className="hidden md:flex items-center gap-1">
          {links.map(({ label, href, icon: Icon, tourId }) => (
            <Link
              key={href}
              href={href}
              data-tour={tourId}
              aria-current={pathname === href ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-all",
                pathname === href
                  ? "text-foreground bg-secondary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* <ThemeToggle />
          <Link href="/map">
            <Button size="sm" className="gap-2 shadow-lg shadow-primary/20">
              <MapPin className="w-4 h-4" />
              Carte
            </Button>
          </Link> */}
          {user && (
            <Button
              variant="ghost"
              size="icon"
              data-tour="nav-aide"
              title="Aide"
              aria-label="Revoir le guide d'accueil"
              onClick={() => setTourRun(true)}
            >
              <HelpCircle className="w-4 h-4" />
            </Button>
          )}
          {user ? (
            <form action={signOutAction}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2"
                title="Se déconnecter"
              >
                <LogOut className="w-4 h-4" />
                {user.name || user.email}
              </Button>
            </form>
          ) : (
            <Link href="/login">
              <Button variant="ghost" size="sm" className="gap-2">
                <LogIn className="w-4 h-4" />
                Connexion
              </Button>
            </Link>
          )}
        </div>
      </div>
      {user && (
        <OnboardingTour role={user.role} run={tourRun} setRun={setTourRun} />
      )}
    </header>
  );
}
```

- [ ] **Step 2: Vérifier la compilation TypeScript**

Run: `npx tsc --noEmit -p .`
Expected: aucune sortie.

- [ ] **Step 3: Vérifier le lint**

Run: `npx eslint src/components/NavBar.tsx`
Expected: aucune sortie.

- [ ] **Step 4: Commit**

```bash
git add src/components/NavBar.tsx
git commit -m "feat(onboarding): brancher OnboardingTour et le bouton Aide dans NavBar"
```

---

## Task 5: Vérification manuelle de bout en bout

**Files:** aucun (vérification uniquement — pas de nouveau code).

**Interfaces:**
- Consumes: l'intégralité de la fonctionnalité (Tasks 1-4) via le serveur de développement réel.

- [ ] **Step 1: Repérer ou créer un utilisateur de test non-onboardé**

Run: `docker exec geoaino_postgres psql -U postgres -d geoaino_db -c "SELECT id, email, role, \"onboardingVuLe\" FROM \"User\" ORDER BY \"createdAt\" DESC LIMIT 5;"`

Si un compte de test connu a `onboardingVuLe` déjà non-NULL, le remettre à NULL pour ce test (remplacer `<id>` par l'id réel) :
`docker exec geoaino_postgres psql -U postgres -d geoaino_db -c "UPDATE \"User\" SET \"onboardingVuLe\" = NULL WHERE id = '<id>';"`

- [ ] **Step 2: Lancer le serveur de dev**

Run: `npm run dev` (en arrière-plan, ou dans un terminal séparé — laisser tourner pour les étapes suivantes)
Expected: serveur accessible sur `http://localhost:3000` (ou le port configuré).

- [ ] **Step 3: Se connecter avec le compte non-onboardé et observer le tour**

Se connecter dans le navigateur avec ce compte. Vérifier :
- Le tour se lance automatiquement (bulle centrée « Bienvenue sur GéoAino »).
- Cliquer « Suivant » fait défiler les spotlights sur Tableau de bord, Cadastre, Historique, Rapports, dans cet ordre, chacun surlignant le vrai lien correspondant dans la `NavBar`.
- Si le compte est ADMIN : une étape supplémentaire surligne « Utilisateurs ». Si non-ADMIN : cette étape est absente (pas de saut visible ni d'erreur).
- La dernière étape surligne le bouton « Aide » (icône `?`).
- Cliquer « Terminer » ferme le tour.

- [ ] **Step 4: Vérifier la persistance en base**

Run (remplacer `<id>`) : `docker exec geoaino_postgres psql -U postgres -d geoaino_db -c "SELECT \"onboardingVuLe\" FROM \"User\" WHERE id = '<id>';"`
Expected: une date/heure récente (non NULL).

- [ ] **Step 5: Vérifier que le tour ne se relance PAS automatiquement**

Recharger la page (F5). Expected : le tour ne se lance plus tout seul (puisque `onboardingVuLe` est maintenant renseigné).

- [ ] **Step 6: Vérifier le bouton « Aide »**

Cliquer sur le bouton « Aide » (icône `?`) dans la `NavBar`. Expected : le tour complet se relance depuis le début, identique à la Step 3. Le terminer ou le passer ne doit pas provoquer d'erreur (l'écriture `onboardingVuLe` est idempotente, cf. Task 2).

- [ ] **Step 7: Vérifier le thème clair**

Basculer le thème de l'app en clair (si un sélecteur de thème est disponible) et relancer le tour via « Aide ». Expected : les couleurs de la bulle du tour (fond, texte, bouton primaire) s'adaptent au thème clair sans code supplémentaire (variables CSS `var(--card)` etc.).

Aucun commit pour cette tâche (vérification uniquement).
