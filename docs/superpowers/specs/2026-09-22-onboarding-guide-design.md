# Guide interactif de bienvenue (onboarding) — design

Date : 2026-09-22

## Contexte et objectif

L'application n'a aujourd'hui aucun mécanisme d'accueil ou d'aide intégrée.
Un nouvel utilisateur atterrit sur le tableau de bord sans aucune
orientation sur les grandes zones de l'app (Cadastre, Historique,
Rapports…).

Objectif : un **tour interactif réel** (spotlight sur les vrais éléments
de l'interface, pas des écrans statiques), déclenché automatiquement à la
première connexion, et rejouable à tout moment via un bouton « Aide »
permanent.

**Périmètre v1** : vue d'ensemble générale (les grandes zones de
navigation). Pas d'aide contextuelle détaillée par page (basculement,
migration en masse, etc.) — à traiter dans une itération ultérieure si
besoin.

## Approche technique

**Librairie : `react-joyride` (v3.2.0)**, retenue après vérification des
docs à jour (`ctx7`) :
- Peer dependencies `react: "16.8 - 19"` / `react-dom: "16.8 - 19"` —
  compatible avec React 19.2.4 de ce projet, sans avertissement de peer
  dependency.
- API déclarative contrôlée (`run`, `stepIndex`, `callback`) qui s'intègre
  naturellement à un composant client React/Next.js, à la différence de
  `driver.js` (API impérative vanilla JS, écartée pour cette raison).

**Point clé simplifiant l'architecture** : tous les liens de navigation
principaux (Tableau de bord, Cadastre, Historique, Rapports, + Utilisateurs
pour l'admin) sont dans `NavBar.tsx`, rendue sur **toutes** les pages
authentifiées (chaque page/layout qui affiche `<NavBar user={...} />` —
`DashboardClient`, `HistoryClient`, `ReportsClient`, `TopologyClient`,
`HomeClient`, `MapAnalysisClient`, `MapEmptyClient`, `AnalysisTableClient`,
`admin/layout.tsx`, `cadastre/layout.tsx`). Le tour peut donc cibler ces
vrais éléments du DOM en un seul parcours continu, monté **une seule fois,
à l'intérieur de `NavBar`** — sans jamais avoir à gérer une navigation
entre pages pendant le déroulé du tour, et sans toucher les ~10 sites
d'appel de `<NavBar>` (le rôle admin, déjà passé via le prop `user`
existant, suffit pour la logique conditionnelle).

## Données et persistance

Nouveau champ sur `User` (`prisma/schema.prisma`) :

```prisma
model User {
  // ... champs existants inchangés
  onboardingVuLe DateTime?
}
```

Migration Prisma standard (`npx prisma migrate dev --name add_onboarding_vu`),
suivant la convention des migrations existantes (`prisma/migrations/`).

## Server Actions

Nouveau fichier `src/app/_actions/onboarding.ts` (racine, pas cadastre —
fonctionnalité transverse à toute l'app) :

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
  // Idempotent : n'écrase pas une date déjà posée.
  await prisma.user.updateMany({
    where: { id: userId, onboardingVuLe: null },
    data: { onboardingVuLe: new Date() },
  });
}
```

## Composants

### `src/components/OnboardingTour.tsx` (nouveau, client)

Encapsule `react-joyride` et toute la logique de contrôle. Props :
`{ role: string | null | undefined }` (pour la diapo admin conditionnelle).

Responsabilités :
- Au montage, appelle `getOnboardingStatus()` ; si `vu === false`, déclenche
  automatiquement le tour (`run = true`).
- Expose un moyen de relancer le tour manuellement (état local `run`,
  remonté au bouton « Aide » de `NavBar` via un `ref`/callback — voir
  détail d'implémentation ci-dessous).
- `callback` : sur `STATUS.FINISHED` ou `STATUS.SKIPPED`, appelle
  `marquerOnboardingVu()` (no-op si déjà vu) et remet `run` à `false`.
- Construit dynamiquement la liste des étapes : inclut l'étape
  « Utilisateurs » uniquement si `role === "ADMIN"`.

Communication avec le bouton « Aide » (dans le même fichier `NavBar.tsx`,
composant parent) : `OnboardingTour` expose son déclenchement via
`useImperativeHandle`/`forwardRef`, **ou**, plus simple et suffisant ici,
l'état `run` vit directement dans `NavBar` (composant parent) et est
passé en prop à `OnboardingTour` (`run`, `setRun`) — évite d'introduire un
ref pour un simple booléen. C'est l'option retenue.

### Étapes du tour (contenu, français)

Cibles par attribut `data-tour` (ajoutés aux éléments existants de
`NavBar.tsx`, pas de nouveaux éléments juste pour le ciblage) :

1. Centré (pas de cible, `placement: "center"`) — Bienvenue : présentation
   rapide de GéoAino (« Détection des erreurs topologiques, correction et
   rapports d'analyse des données cadastrales du Sénégal », cf. métadonnées
   déjà en place dans `layout.tsx`).
2. `[data-tour="nav-dashboard"]` — Tableau de bord : vue d'ensemble des
   imports et analyses.
3. `[data-tour="nav-cadastre"]` — Cadastre : basculement NICAD 2013→2026,
   migration en masse, gestion des sections, import DXF/shapefile (un
   seul écran, survol — pas de détail).
4. `[data-tour="nav-history"]` — Historique : traçabilité de toutes les
   actions effectuées.
5. `[data-tour="nav-reports"]` — Rapports : consultation et export des
   résultats d'analyse.
6. *(role === "ADMIN" seulement)* `[data-tour="nav-admin-users"]` —
   Gestion des utilisateurs et de leurs rôles.
7. `[data-tour="nav-aide"]` — Clôture : « Vous pouvez revoir ce guide à
   tout moment ici. »

### Modifications de `NavBar.tsx`

- Ajout d'un champ `tourId` sur chaque entrée de `NAV_LINKS`
  (`{ label, href, icon, tourId }`), reporté en `data-tour={tourId}` sur
  le `<Link>` du menu **desktop** uniquement (`nav.hidden md:flex` — le
  menu mobile, dans le `Sheet`, n'est pas ciblé par le tour ; le tour
  suppose une largeur desktop, cohérent avec le fait que `react-joyride`
  positionne ses bulles par rapport à des éléments visibles — si l'élément
  ciblé est masqué en mobile, cette étape est simplement sautée par
  Joyride, cf. Gestion des erreurs).
- Nouveau bouton « Aide » (icône `HelpCircle` de `lucide-react`,
  `variant="ghost"`, `size="icon"`), `data-tour="nav-aide"`, ajouté dans le
  groupe d'actions à droite (à côté du bouton de déconnexion), visible
  uniquement si `user` est défini. `onClick` → `setRun(true)`.
- Rendu de `<OnboardingTour role={user?.role} run={run} setRun={setRun} />`
  juste avant la fermeture du `<header>`, uniquement si `user` est défini
  (jamais de tour pour un visiteur non connecté).

## Style

`react-joyride` accepte un prop `styles.options` pour surcharger ses
couleurs. Utilisation directe des variables CSS du design system
« Graticule » (`globals.css`, déjà thémées clair/sombre) plutôt que des
couleurs en dur — s'adapte automatiquement au thème actif sans code JS
supplémentaire :

```ts
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
```

`zIndex: 10000` nécessaire pour passer au-dessus du `header` `sticky
z-50` existant.

## Gestion des erreurs / cas limites

- **Élément cible absent** (ex. tour lancé sur mobile où le menu desktop
  est masqué, ou étape admin pour un non-admin déjà filtrée en amont) :
  `react-joyride` gère nativement `EVENTS.TARGET_NOT_FOUND` en passant à
  l'étape suivante — pas de code supplémentaire requis, comportement par
  défaut suffisant pour ce cas rare (l'onboarding vise avant tout le
  premier usage desktop).
- **Échec de `getOnboardingStatus()`** (session expirée pendant l'appel,
  erreur réseau) : capturé, le tour ne se lance simplement pas
  automatiquement (pas de blocage ni de message d'erreur intrusif) ;
  l'utilisateur peut toujours le lancer manuellement via « Aide ».
- **Échec de `marquerOnboardingVu()`** : capturé et ignoré (log console
  seulement) — au pire, le tour se relance à la prochaine connexion, pas
  de conséquence grave.
- **Utilisateur clique « Aide » alors que le tour tourne déjà** : bouton
  sans effet si `run === true` (pas de double montage).

## Testing

Pas de test automatisé pertinent pour l'animation/positionnement visuel
de `react-joyride` (comportement de librairie tierce déjà testée en
amont). Vérification :
- `tsc --noEmit` + `eslint` sur tous les fichiers touchés.
- Migration Prisma appliquée sans erreur (`prisma migrate dev`).
- Test manuel via serveur de dev : compte avec `onboardingVuLe: null` →
  tour auto-lancé au chargement ; bouton « Aide » relance le tour à
  volonté ; compte ADMIN voit l'étape « Utilisateurs », compte non-admin
  ne la voit pas ; `onboardingVuLe` bien posé en base après complétion ou
  passage.

## Hors périmètre (v1)

- Aide contextuelle détaillée par page (basculement, migration en masse,
  gestion des sections…).
- Tour multi-pages avec navigation automatique entre routes.
- Personnalisation du contenu du tour par l'utilisateur/l'admin.
