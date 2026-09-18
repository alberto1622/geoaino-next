#!/usr/bin/env node
/**
 * Build le vendor tileserver-gl : installe tileserver-gl + sqlite3 dans
 * desktop/vendor/tileserver, force le mode "light" (sans dépendance canvas
 * native) et copie le binaire sqlite3 natif depuis le node_modules racine.
 *
 * Usage : npx tsx desktop/scripts/setup-tileserver.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const VENDOR = path.join(ROOT, "desktop", "vendor", "tileserver");

console.log("[setup-tileserver] Préparation du vendor tileserver-gl...");

fs.mkdirSync(VENDOR, { recursive: true });

// 1. Initialiser le package.json du vendor
const packageJson = {
  name: "tileserver-vendor",
  version: "1.0.0",
  private: true,
  packageManager: "npm@11",
};
fs.writeFileSync(
  path.join(VENDOR, "package.json"),
  JSON.stringify(packageJson, null, 2),
);

// 2. Installer tileserver-gl + sqlite3
console.log("[setup-tileserver] npm install tileserver-gl@5.6.0 sqlite3@5.1.7...");
execFileSync("npm", ["install", "tileserver-gl@5.6.0", "sqlite3@5.1.7"], {
  cwd: VENDOR,
  stdio: "inherit",
});

// 3. Forcer le mode "light" pour éviter le chargement de canvas natif
//    tileserver-gl détecte le suffixe "-light" dans package.name
const tsPkgPath = path.join(VENDOR, "node_modules", "tileserver-gl", "package.json");
const tsPkg = JSON.parse(fs.readFileSync(tsPkgPath, "utf8"));
tsPkg.name = "tileserver-gl-light";
fs.writeFileSync(tsPkgPath, JSON.stringify(tsPkg, null, 2));
console.log("[setup-tileserver] Mode light forcé (évite la dépendance canvas native).");

// 4. Copier le binaire sqlite3 natif depuis le node_modules racine si besoin
const srcBinding = path.join(ROOT, "node_modules", "sqlite3", "build", "Release", "node_sqlite3.node");
const dstBindingDir = path.join(VENDOR, "node_modules", "sqlite3", "build", "Release");
if (fs.existsSync(srcBinding)) {
  fs.mkdirSync(dstBindingDir, { recursive: true });
  fs.copyFileSync(srcBinding, path.join(dstBindingDir, "node_sqlite3.node"));
  console.log("[setup-tileserver] Binaire sqlite3 natif copié.");
} else {
  console.warn("[setup-tileserver] ATTENTION : binaire sqlite3 natif introuvable dans node_modules racine.");
  console.warn("  Le serveur de tuiles peut échouer au runtime. Exécutez d'abord 'npm install' à la racine.");
}

// 5. Nettoyer le package-lock inutile
if (fs.existsSync(path.join(VENDOR, "package-lock.json"))) {
  fs.unlinkSync(path.join(VENDOR, "package-lock.json"));
}

// 6. Copier la config tileserver-gl + les tuiles raster/vectorielles pour le mode offline.
//    desktop/vendor/tiles/ contient config.json (styles OSM Bright) + senegal.mbtiles.
//    tileserver-gl lit sa config depuis <cwd>/config.json + <cwd>/tiles/
const sourceTilesConfig = path.join(ROOT, "desktop", "vendor", "tiles", "config.json");
const destTileserverDir = path.join(VENDOR, "tileserver-gl");
const destConfig = path.join(destTileserverDir, "config.json");
const destTilesDir = path.join(destTileserverDir, "tiles");

if (fs.existsSync(sourceTilesConfig)) {
  fs.mkdirSync(destTileserverDir, { recursive: true });
  fs.copyFileSync(sourceTilesConfig, destConfig);
  console.log("[setup-tileserver] config.json copié depuis desktop/vendor/tiles/");

  // Copier senegal.mbtiles dans tileserver-gl/tiles/
  const sourceMbtiles = path.join(ROOT, "desktop", "vendor", "tiles", "senegal.mbtiles");
  if (fs.existsSync(sourceMbtiles)) {
    fs.mkdirSync(destTilesDir, { recursive: true });
    fs.copyFileSync(sourceMbtiles, path.join(destTilesDir, "senegal.mbtiles"));
    console.log("[setup-tileserver] senegal.mbtiles copié dans tileserver-gl/tiles/");
  }
} else {
  console.warn("[setup-tileserver] ATTENTION : desktop/vendor/tiles/config.json introuvable — le serveur de tuiles offline sera sans tuiles.");
}

console.log("[setup-tileserver] Vendor prêt : desktop/vendor/tileserver/");
