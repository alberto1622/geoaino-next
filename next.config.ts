import path from "path";
import type { NextConfig } from "next";

const desktopBuild = process.env.GEOAINO_DESKTOP_BUILD === "1";

// Injection des chemins absolus pour le mode desktop build. Les modules
// geo-storage.ts et storage.ts utilisent un placeholder "/ROOT/uploads/..."
// par défaut pour éviter les warnings Turbopack (patterns trop larges). On
// injecte ici la valeur réelle au moment du build.
if (desktopBuild) {
  process.env.LOCAL_GEOJSON_DIR ??= path.join(process.cwd(), "uploads", "geojson");
  process.env.IMPORT_UPLOADS_DIR ??= path.join(process.cwd(), "uploads", "imports");
}

const isDev = process.env.NODE_ENV !== "production";

// CSP sans nonce (guide Next « Without Nonces ») : garde le rendu statique.
// 'unsafe-inline' reste requis pour le script de thème de layout.tsx et les
// scripts inline de Next. Origines externes réellement utilisées :
// tuiles OSM (src/lib/tiles-url.ts), icônes Leaflet sur cdnjs, et serveur de
// tuiles local du mode bureau (http://127.0.0.1:<port>). MapLibre crée ses
// workers depuis des URL blob:. Pas de `upgrade-insecure-requests` : il
// casserait les tuiles locales HTTP du mode bureau.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://tile.openstreetmap.org https://cdnjs.cloudflare.com http://127.0.0.1:*",
  "font-src 'self' data:",
  "connect-src 'self' https://tile.openstreetmap.org http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  // HSTS : ignoré par les navigateurs sur une réponse HTTP, n'a d'effet que
  // derrière HTTPS. Exclu du bureau (servi en HTTP local) et du dev. Sans
  // `includeSubDomains`/`preload` : engagements à prendre sur le domaine réel.
  ...(!isDev && !desktopBuild
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000" }]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // `output: "standalone"` ne doit s'appliquer QU'au build desktop
  // (`npm run build:standalone`, invoque par `dist:desktop`) : le Dockerfile
  // de l'app web lance un `next build` normal puis `next start` (jamais le
  // `.next/standalone/server.js`), donc un `standalone` inconditionnel
  // faisait produire a l'image Docker web un `.next/standalone/node_modules`
  // trace complet en plus du `.next` normal — copie entiere et jamais lue,
  // doublant inutilement la taille de l'image. `GEOAINO_DESKTOP_BUILD` n'est
  // positionnee que par le script `build:standalone` (cross-env, pour rester
  // portable Windows/POSIX) ; un `next build` nu (web/Docker) laisse `output`
  // a `undefined`, comportement par defaut de Next.
  output: process.env.GEOAINO_DESKTOP_BUILD ? "standalone" : undefined,
  // Sans ceci, Next.js remonte l'arborescence a la recherche d'un
  // lockfile pour deviner la racine de tracage et peut tomber sur un
  // lockfile sans rapport plus haut dans l'arborescence (ex. un
  // pnpm-lock.yaml du profil utilisateur) : .next/standalone se retrouve
  // alors imbrique sous ce chemin errone au lieu d'avoir server.js et
  // node_modules a sa racine, ce qui casse le contrat consomme par
  // Task 9 (next-server.ts) et Task 10 (electron-builder.yml).
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["shapefile", "jszip", "proj4"],
  // `src/lib/import/storage.ts` construit UPLOAD_DIR a partir d'un chemin
  // DYNAMIQUE (process.env.IMPORT_UPLOADS_DIR ?? path.join(process.cwd(), ...))
  // passe a fs.mkdir/fs.readFile : le traceur de fichiers de Next ne peut pas
  // resoudre ce chemin statiquement, donc il balaie par prudence tout
  // l'arbre sous `outputFileTracingRoot` (cf. ci-dessus, fixe a process.cwd()
  // pour Task 9/10) des qu'une route importe ce module. Consequence
  // concrete constatee : `.next/standalone` embarquait une copie complete de
  // `desktop/` (dont `desktop/vendor/pg-portable`, ~2 Go) — un gonflement
  // multi-Go entierement inutile, puisque `desktop/**` est deja embarque
  // separement et correctement via les `extraResources` de
  // `desktop/electron-builder.yml`. Le meme balayage conservateur embarquait
  // aussi (revue finale, Finding 2) tout le reste de l'arbre projet sans
  // rapport avec le runtime standalone : `src/` (Next compile deja son
  // contenu utile dans `.next/server`, la source brute n'est jamais lue a
  // l'execution), `scripts/`, `ML/`, `docs/ressources/traitements_process/` (avec un PDF de
  // documentation interne), `docs/`, des `.md` et `.geojson` epars, et meme
  // un `hs_err_pid*.log` de crash JVM laisse par une machine de build —
  // livres tels quels aux clients dans l'installateur. Cette exclusion
  // n'arrete que ce balayage automatique et inutile du traceur Next ; elle
  // n'a aucun changement fonctionnel pour l'app desktop elle-meme.
  // La cle `"**"` ci-dessous est LOAD-BEARING et n'est PAS interchangeable
  // avec l'idiome documente par Next `/*` : verifie dans le code de Next
  // (`collect-build-traces.js`) que seule `"**"` atteint la liste
  // d'exclusion du bundle `next-server` (sans l'option `contains: true`
  // que `/*` necessiterait pour produire le meme effet) ; le chemin de
  // filtrage par route (l'autre mecanisme cense honorer `/*`) est par
  // ailleurs inerte sur Windows a cause d'une incompatibilite backslash vs
  // picomatch. Ne PAS « simplifier » cette cle vers `/*` : cela reactiverait
  // silencieusement le gonflement multi-Go decrit ci-dessus.
  outputFileTracingExcludes: {
    "**": [
      "./desktop/**",
      "./src/**",
      "./scripts/**",
      "./ML/**",
      "./docs/**",
      "./*.md",
      "./*.geojson",
      "./*.log",
      // `uploads/` (racine du depot) accumule les fichiers DXF/shapefile
      // reellement importes via l'app web — donnees clients, potentiellement
      // des dizaines de Go. Meme cause que les exclusions ci-dessus (chemin
      // DYNAMIQUE dans src/lib/import/storage.ts) : sans cette entree,
      // `.next/standalone` embarquait la totalite de ce dossier (constate :
      // 24 Go dans resources/app, a l'origine d'un echec de packaging NSIS —
      // makensis.exe, 32 bits, ne peut pas mmap un payload > ~2 Go). Absente
      // de la revue finale du chantier bureau autonome initial car ce
      // dossier etait alors vide/petit sur la machine de build.
      "./uploads/**",
      // Exclusion des modules de stockage qui utilisent des chemins dynamiques
      // basés sur process.cwd() — le traceur next embarquerait tout le projet
      // sans cela (cf. LOCAL_GEOJSON_DIR et UPLOAD_DIR)
      "./src/lib/geo-storage.ts",
      "./src/lib/import/storage.ts",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
