import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  serverExternalPackages: [
    "shapefile",
    "jszip",
    "proj4",
    // Module « Vérifier des bornes » — import PDF : lus dynamiquement côté
    // serveur, jamais bundlés (binaire natif, workers, WASM).
    "pdf-lib",
    "pdfjs-dist",
    "tesseract.js",
    "@napi-rs/canvas",
  ],
  // Le module de verification de bornes charge pdfjs-dist/tesseract.js/
  // @napi-rs/canvas via un import() a specificateur VARIABLE (cf. ocr.ts,
  // pdfTableauTexte.ts) — delibere pour que leur absence soit toleree en
  // web. Consequence : le tracage de fichiers de `output: standalone` ne
  // les detecte pas par analyse statique et les omettrait du bundle. Sur
  // le bureau autonome, ces paquets doivent reellement fonctionner
  // (parite complete) : on les inclut donc explicitement.
  outputFileTracingIncludes: {
    "/api/cadastre/verif/**": [
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-win32-x64-msvc/**/*",
    ],
  },
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
  // l'execution), `scripts/`, `ML/`, `traitements_process/` (avec un PDF de
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
      "./traitements_process/**",
      "./docs/**",
      "./*.md",
      "./*.geojson",
      "./*.log",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
