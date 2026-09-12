import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hash } from "bcryptjs";
import { demarrerPostgresPortable, type ClusterPostgres } from "./postgres-manager";
import { trouverPortLibre } from "./port-utils";
import { demarrerNextStandalone, attendreServeurPret, type ServeurNext } from "./next-server";
import { construireEnvRuntime, dossierPgData, dossierLogs } from "./runtime-env";

const CANDIDATS_PORT_PG = [54329, 54330, 54331, 54332, 54333];
const CANDIDATS_PORT_NEXT = [4173, 4174, 4175, 4176, 4177];

const cheminRessources = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..", "vendor");

let clusterPg: ClusterPostgres | null = null;
let serveurNext: ServeurNext | null = null;
let fenetre: BrowserWindow | null = null;

function executerPsql(port: number, args: string[]) {
  const psql = path.join(cheminRessources, "pg-portable", "bin", "psql.exe");
  return spawnSync(psql, ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", ...args]);
}

/** Cree la base applicative + l'extension PostGIS si elles n'existent pas encore. */
function assurerBaseEtExtension(port: number): void {
  const existe = executerPsql(port, ["-tAc", "SELECT 1 FROM pg_database WHERE datname = 'geoaino'"]);
  if (existe.stdout?.toString().trim() !== "1") {
    const creation = executerPsql(port, ["-c", "CREATE DATABASE geoaino"]);
    if (creation.status !== 0) {
      throw new Error(`Creation de la base 'geoaino' echouee : ${creation.stderr?.toString()}`);
    }
  }
  const extension = executerPsql(port, ["-d", "geoaino", "-c", "CREATE EXTENSION IF NOT EXISTS postgis;"]);
  if (extension.status !== 0) {
    throw new Error(`CREATE EXTENSION postgis echoue : ${extension.stderr?.toString()}`);
  }
}

// L'historique `prisma/migrations/` contient une lacune reelle et anterieure
// a ce correctif : aucune migration ne cree la table `limite_section`, alors
// qu'une migration ulterieure tente d'indexer cette meme table — contre une
// base fraichement vide, `prisma migrate deploy` echoue donc systematiquement
// (P3018 : relation "limite_section" does not exist). Corriger l'historique
// partage toucherait aussi la base de la webapp deployee ; l'utilisateur a
// choisi plutot de faire demarrer l'app desktop autrement.
// `prisma db push` compare directement `schema.prisma` a l'etat reel de la
// base et applique la difference : il ne rejoue jamais l'historique de
// migrations, donc la lacune ci-dessus ne le concerne pas — il fonctionne
// correctement meme sur une base fraiche/vide.
// Contrepartie acceptee : `--accept-data-loss` est necessaire pour rester
// non-interactif (aucun prompt possible dans une app GUI empaquetee). Sans
// consequence au tout premier lancement (base vide), mais signifie qu'une
// evolution de schema qui supprimerait des donnees lors d'une mise a jour
// ulterieure de l'app s'appliquerait silencieusement plutot que de demander
// confirmation — compromis assume explicitement par l'utilisateur, pas un
// oubli.
function synchroniserSchema(env: NodeJS.ProcessEnv): void {
  const migrate = spawnSync(
    process.execPath,
    [
      path.join(cheminRessources, "prisma-cli", "build", "index.js"),
      "db",
      "push",
      "--schema",
      path.join(cheminRessources, "prisma", "schema.prisma"),
      "--accept-data-loss",
      "--skip-generate",
    ],
    // `timeout` : filet de securite contre un blocage indefini (cf. Tasks 1/2
    // pour des cas similaires d'attente non bornee) — une migration qui n'a
    // pas termine en 60s est anormale et doit echouer plutot que geler
    // durablement le demarrage de l'app.
    { env, cwd: cheminRessources, timeout: 60_000 },
  );
  if (migrate.status !== 0) {
    throw new Error(`prisma db push a echoue : ${migrate.stderr?.toString() || migrate.stdout?.toString()}`);
  }
}

/**
 * Cree un compte ADMIN initial si la base ne contient encore aucun
 * utilisateur (premier lancement seulement) — sans ca, l'operateur n'a
 * aucun moyen de se connecter a une installation neuve (spec, § Cycle de
 * demarrage). Insertion SQL directe plutot que via Prisma Client : le
 * process principal Electron n'a besoin d'aucune autre dependance a
 * Prisma que le CLI deja invoque pour les migrations (cf.
 * synchroniserSchema). Le hachage utilise `bcryptjs` — meme algorithme
 * que `CredentialsProvider` (src/lib/auth.ts) — pour qu'un mot de passe
 * cree ici s'authentifie normalement une fois l'app ouverte.
 * Renvoie `email / mot de passe` si un compte a ete cree, sinon `null`.
 */
async function amorcerCompteAdmin(port: number): Promise<string | null> {
  const compte = executerPsql(port, ["-d", "geoaino", "-tAc", 'SELECT count(*) FROM "User"']);
  if (compte.status !== 0) {
    throw new Error(`Verification du compte initial echouee : ${compte.stderr?.toString()}`);
  }
  if (Number(compte.stdout?.toString().trim()) > 0) return null;

  const email = "admin@geoaino.local";
  const motDePasse = randomBytes(9).toString("base64url");
  const hachage = (await hash(motDePasse, 10)).replace(/'/g, "''");
  const insertion = executerPsql(port, [
    "-d", "geoaino",
    "-c",
    // "updatedAt" est NOT NULL sans DEFAULT en base (@updatedAt n'est gere
    // qu'au niveau applicatif par Prisma Client, jamais absent ici) : doit
    // etre fourni explicitement, sinon l'insertion echoue des le tout
    // premier lancement.
    `INSERT INTO "User" (id, email, password, role, "lastSignedIn", "updatedAt") VALUES (gen_random_uuid()::text, '${email}', '${hachage}', 'ADMIN', now(), now());`,
  ]);
  if (insertion.status !== 0) {
    throw new Error(`Creation du compte ADMIN initial echouee : ${insertion.stderr?.toString()}`);
  }
  return `${email} / ${motDePasse}`;
}

async function demarrerApplication(): Promise<void> {
  clusterPg = await demarrerPostgresPortable({
    binDir: path.join(cheminRessources, "pg-portable", "bin"),
    dataDir: dossierPgData(),
    candidatsPort: CANDIDATS_PORT_PG,
  });

  assurerBaseEtExtension(clusterPg.port);

  const portNext = await trouverPortLibre(CANDIDATS_PORT_NEXT);
  const env = construireEnvRuntime({
    portPostgres: clusterPg.port,
    portNext,
    cheminRessources,
  });

  synchroniserSchema(env);

  const identifiantsInitiaux = await amorcerCompteAdmin(clusterPg.port);
  if (identifiantsInitiaux) {
    dialog.showMessageBoxSync({
      type: "info",
      title: "Compte administrateur cree",
      message: "Un compte administrateur a ete cree pour cette installation.",
      detail: `Identifiants (a noter, non recuperables ensuite) :\n${identifiantsInitiaux}`,
    });
  }

  serveurNext = demarrerNextStandalone({
    cheminServeur: path.join(cheminRessources, "app", "server.js"),
    env,
    fichierLog: path.join(dossierLogs(), "next.log"),
  });
  await attendreServeurPret(portNext);

  fenetre = new BrowserWindow({ width: 1400, height: 900, show: false });
  await fenetre.loadURL(`http://127.0.0.1:${portNext}`);
  fenetre.show();
}

app.on("ready", () => {
  demarrerApplication().catch((err) => {
    console.error("Echec du demarrage :", err);
    // Une app GUI empaquetee n'a pas de console visible : sans cette boite
    // de dialogue, un echec de demarrage (ex. Critical #1 avant correctif)
    // disparaissait silencieusement, sans aucun retour pour l'operateur.
    dialog.showErrorBox("Echec du demarrage", String(err));
    app.quit();
  });
});

let arretEnCours = false;
app.on("before-quit", (event) => {
  if (arretEnCours || (!serveurNext && !clusterPg)) return;
  arretEnCours = true;
  event.preventDefault();
  (async () => {
    // `finally` : si l'arret du serveur Next ou du cluster Postgres rejette,
    // l'app doit tout de meme redevenir quittable (sinon seul le
    // Gestionnaire des taches permet de la fermer, avec Postgres reste actif).
    try {
      if (serveurNext) await serveurNext.arreter();
      if (clusterPg) await clusterPg.arreter();
    } finally {
      serveurNext = null;
      clusterPg = null;
      app.quit();
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
