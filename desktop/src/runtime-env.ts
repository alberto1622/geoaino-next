import { app } from "electron";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Racine des donnees persistantes de l'app (survit aux mises a jour). */
export function dossierDonnees(): string {
  const dir = path.join(app.getPath("appData"), "GeoAino");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dossierPgData(): string {
  return path.join(dossierDonnees(), "pgdata");
}

export function dossierLogs(): string {
  const dir = path.join(dossierDonnees(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dossierCacheTesseract(): string {
  const dir = path.join(dossierDonnees(), "tesseract-cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * NEXTAUTH_SECRET doit rester stable entre deux lancements (sinon les
 * sessions sont invalidees a chaque redemarrage) mais n'a pas besoin
 * d'etre connu a l'avance : genere une seule fois, a la premiere execution.
 */
export function secretAuthPersiste(): string {
  const fichier = path.join(dossierDonnees(), "auth.secret");
  if (existsSync(fichier)) return readFileSync(fichier, "utf8").trim();
  const secret = randomBytes(32).toString("hex");
  writeFileSync(fichier, secret, "utf8");
  return secret;
}

/**
 * Amorce le cache local de donnees de langue tesseract avec le fichier
 * embarque dans les ressources de l'app, si absent (premier lancement).
 * `ocr.ts` lit ce dossier via GEOAINO_TESSERACT_LANG_PATH (cf. Task 5).
 */
export function amorcerCacheTesseract(cheminRessources: string): string {
  const dest = dossierCacheTesseract();
  const cible = path.join(dest, "eng.traineddata.gz");
  if (!existsSync(cible)) {
    const source = path.join(cheminRessources, "tesseract-lang", "eng.traineddata.gz");
    copyFileSync(source, cible);
  }
  return dest;
}

export function construireEnvRuntime(options: {
  portPostgres: number;
  portNext: number;
  cheminRessources: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(options.portNext),
    DATABASE_URL: `postgresql://postgres@127.0.0.1:${options.portPostgres}/geoaino?schema=public`,
    NEXTAUTH_URL: `http://127.0.0.1:${options.portNext}`,
    NEXTAUTH_SECRET: secretAuthPersiste(),
    // Le `server.js` standalone de Next se lie a `process.env.HOSTNAME`
    // quand elle est definie (au lieu de retomber sur `0.0.0.0`) — or toute
    // l'architecture de l'app suppose une adresse loopback uniquement
    // (Postgres, `attendreServeurPret`, la BrowserWindow visent tous
    // `127.0.0.1`). Un `HOSTNAME` ambiant herite de `...process.env`
    // (ex. nom de machine Windows resolu vers un adaptateur reseau virtuel
    // WSL/Hyper-V) rendrait alors le serveur silencieusement injoignable a
    // l'adresse attendue. Fixe explicitement apres le spread pour ecraser
    // toute valeur ambiante.
    HOSTNAME: "127.0.0.1",
    // Auth.js v5 valide l'en-tete Host de chaque requete et la rejette
    // (`UntrustedHost`) sauf opt-in explicite — comportement voulu pour un
    // deploiement standard, mais qui bloque ici `attendreServeurPret`
    // (sonde `/api/auth/session`) des que le Host recu ne correspond pas
    // exactement a ce qui est attendu. `AUTH_TRUST_HOST` est l'equivalent
    // en variable d'environnement de `trustHost: true` dans la config
    // NextAuth — evite de toucher `src/lib/auth.ts` (partage avec la
    // webapp deployee, ou cette variable n'est simplement jamais definie
    // et n'a donc aucun effet).
    AUTH_TRUST_HOST: "true",
    GEOAINO_TESSERACT_LANG_PATH: amorcerCacheTesseract(options.cheminRessources),
    // Dans le process principal Electron, `process.execPath` designe le
    // binaire Electron lui-meme, pas un Node.js classique : le relancer via
    // `spawn`/`spawnSync` sans cette variable demarre une seconde instance
    // complete de l'app plutot que d'executer le script donne comme Node.
    // Necessaire pour tout process enfant lance avec `process.execPath`
    // (serveur Next standalone, CLI Prisma pour les migrations).
    ELECTRON_RUN_AS_NODE: "1",
  };
}
