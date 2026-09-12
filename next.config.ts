import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
  // `desktop/electron-builder.yml`. Cette exclusion n'arrete que ce
  // balayage automatique et inutile du traceur Next ; elle n'a aucun
  // changement fonctionnel pour l'app desktop elle-meme, et ne concerne
  // pas (a elle seule) un autre bug distinct constate separement : la copie
  // extraResources `.next/standalone -> app` qui omet par ailleurs tout le
  // sous-dossier `node_modules` de la sortie standalone.
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
    "**": ["./desktop/**"],
  },
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
