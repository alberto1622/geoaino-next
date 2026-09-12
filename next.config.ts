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
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
