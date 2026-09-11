import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
};

export default nextConfig;
