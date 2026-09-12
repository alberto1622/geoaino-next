// `next build` (output: standalone) ne copie ni public/ ni .next/static
// dans .next/standalone : a faire manuellement apres chaque build,
// sinon le serveur standalone demarre mais sert des pages cassees.
import { cpSync, existsSync } from "node:fs";

if (!existsSync(".next/standalone")) {
  console.error("./.next/standalone est absent — lancez `next build` avant ce script.");
  process.exit(1);
}

cpSync("public", ".next/standalone/public", { recursive: true });
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
console.log("OK : public/ et .next/static copies dans .next/standalone/.");
