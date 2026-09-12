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

function appliquerMigrations(env: NodeJS.ProcessEnv): void {
  const migrate = spawnSync(
    process.execPath,
    [
      path.join(cheminRessources, "prisma-cli", "build", "index.js"),
      "migrate",
      "deploy",
      "--schema",
      path.join(cheminRessources, "prisma", "schema.prisma"),
    ],
    { env, cwd: cheminRessources },
  );
  if (migrate.status !== 0) {
    throw new Error(`prisma migrate deploy a echoue : ${migrate.stderr?.toString() || migrate.stdout?.toString()}`);
  }
}

/**
 * Cree un compte ADMIN initial si la base ne contient encore aucun
 * utilisateur (premier lancement seulement) — sans ca, l'operateur n'a
 * aucun moyen de se connecter a une installation neuve (spec, § Cycle de
 * demarrage). Insertion SQL directe plutot que via Prisma Client : le
 * process principal Electron n'a besoin d'aucune autre dependance a
 * Prisma que le CLI deja invoque pour les migrations (cf.
 * appliquerMigrations). Le hachage utilise `bcryptjs` — meme algorithme
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
    `INSERT INTO "User" (id, email, password, role, "lastSignedIn") VALUES (gen_random_uuid()::text, '${email}', '${hachage}', 'ADMIN', now());`,
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

  appliquerMigrations(env);

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
    app.quit();
  });
});

let arretEnCours = false;
app.on("before-quit", (event) => {
  if (arretEnCours || (!serveurNext && !clusterPg)) return;
  arretEnCours = true;
  event.preventDefault();
  (async () => {
    if (serveurNext) await serveurNext.arreter();
    if (clusterPg) await clusterPg.arreter();
    serveurNext = null;
    clusterPg = null;
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
