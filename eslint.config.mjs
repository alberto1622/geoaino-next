import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Sorties de build et binaires tiers du mode bureau (≈1 700 fichiers JS
    // générés/vendorisés) : les analyser faisait échouer `npx eslint .` par
    // manque de mémoire. `desktop/src` et `desktop/scripts` restent analysés.
    "desktop/dist/**",
    "desktop/dist-installer/**",
    "desktop/vendor/**",
    // Données importées (DXF/SHP clients), jamais du code.
    "uploads/**",
    // Copies de travail (git worktrees) des sessions Claude Code.
    ".claude/**",
  ]),
]);

export default eslintConfig;
