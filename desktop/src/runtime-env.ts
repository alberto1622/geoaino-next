import { app } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Fichier de secours pour les identifiants du compte ADMIN initial (cf.
 * Finding 7 revue finale) : la boite de dialogue affichant ce mot de passe
 * ne s'affiche qu'une seule fois, sans moyen de le recopier. Si l'operateur
 * (non technicien) le lit mal, la seule recuperation possible sinon est de
 * reinitialiser tout `pgdata` (perte de donnees). Ce n'est PAS un enjeu de
 * securite au-dela de ce que la boite de dialogue expose deja : quiconque a
 * acces a `%APPDATA%\GeoAino` a de toute facon deja acces complet au
 * repertoire de donnees Postgres local.
 */
export function cheminIdentifiantsInitiaux(): string {
  return path.join(dossierDonnees(), "identifiants-initiaux.txt");
}

/** Chemin de la licence d'activation persistee (revalidee a chaque lancement). */
export function cheminLicence(): string {
  return path.join(dossierDonnees(), "licence.dat");
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

export function construireEnvRuntime(options: {
  portPostgres: number;
  portNext: number;
  /** MBTiles du fond de carte (lu par /api/tiles, cf. src/lib/basemap-tiles.ts). */
  cheminFondCarte: string;
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
    // Dans le process principal Electron, `process.execPath` designe le
    // binaire Electron lui-meme, pas un Node.js classique : le relancer via
    // `spawn`/`spawnSync` sans cette variable demarre une seconde instance
    // complete de l'app plutot que d'executer le script donne comme Node.
    // Necessaire pour tout process enfant lance avec `process.execPath`
    // (serveur Next standalone, CLI Prisma pour la synchronisation du schema).
    ELECTRON_RUN_AS_NODE: "1",
    // Fond de carte hors ligne (tuiles vectorielles OpenMapTiles).
    BASEMAP_MBTILES_PATH: options.cheminFondCarte,
  };
}
