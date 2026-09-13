import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hash } from "bcryptjs";
import { demarrerPostgresPortable, type ClusterPostgres } from "./postgres-manager";
import { trouverPortLibre } from "./port-utils";
import { demarrerNextStandalone, attendreServeurPret, type ServeurNext } from "./next-server";
import { construireEnvRuntime, dossierPgData, dossierLogs, cheminIdentifiantsInitiaux } from "./runtime-env";
import { empreinteMachine } from "./machine-id";
import { chargerLicenceEnregistree, enregistrerLicence, licenceEstValide, type Licence } from "./licence";

const CANDIDATS_PORT_PG = [54329, 54330, 54331, 54332, 54333];
const CANDIDATS_PORT_NEXT = [4173, 4174, 4175, 4176, 4177];

const cheminRessources = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..", "vendor");

let clusterPg: ClusterPostgres | null = null;
let serveurNext: ServeurNext | null = null;
let fenetre: BrowserWindow | null = null;

// Sans verrou mono-instance, un double-clic (ou un raccourci lance deux fois)
// demarre une deuxieme instance Electron qui tente son propre `pg_ctl start`
// contre le MEME repertoire de donnees que la premiere instance deja active
// — echec garanti, avec une boite de dialogue d'erreur brute et alarmante
// (cf. Finding 6 revue finale) au lieu de simplement rebasculer sur la
// fenetre deja ouverte. `requestSingleInstanceLock` doit etre appele avant
// tout autre traitement significatif : la seconde instance doit quitter
// immediatement sans jamais tenter de demarrer son propre cluster Postgres.
const verrouAcquis = app.requestSingleInstanceLock();
if (!verrouAcquis) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (fenetre) {
      if (fenetre.isMinimized()) fenetre.restore();
      fenetre.focus();
    }
  });

  // `app.quit()` appele AVANT que l'app soit "ready" ne supprime pas
  // l'evenement "ready" a venir (comportement documente d'Electron) : ces
  // handlers doivent donc rester a l'interieur de ce bloc `else`, sinon
  // l'instance perdante peut quand meme tenter de demarrer son propre
  // cluster Postgres contre le repertoire de donnees deja tenu par la
  // premiere instance (residu de la revue finale, Finding #5).
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
}

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
  const sync = spawnSync(
    process.execPath,
    [
      path.join(cheminRessources, "node_modules", "prisma", "build", "index.js"),
      "db",
      "push",
      "--schema",
      path.join(cheminRessources, "prisma", "schema.prisma"),
      "--accept-data-loss",
      "--skip-generate",
    ],
    // `timeout` : filet de securite contre un blocage indefini (cf. Tasks 1/2
    // pour des cas similaires d'attente non bornee) — une synchronisation de
    // schema qui n'a pas termine en 60s est anormale et doit echouer plutot
    // que geler durablement le demarrage de l'app.
    { env, cwd: cheminRessources, timeout: 60_000 },
  );
  if (sync.status !== 0) {
    // `sync.error` : renseigne specifiquement en cas de timeout (le process
    // est alors tue avant meme de produire un stdout/stderr exploitable —
    // sans ce champ, l'erreur levee ici serait vide et donc indiagnostiquable).
    throw new Error(
      `prisma db push a echoue : ${sync.stderr?.toString() || sync.stdout?.toString() || sync.error?.message}`,
    );
  }
}

// `db push` diffe `schema.prisma` contre la base reelle (cf. synchroniserSchema
// ci-dessus) mais ne peut pas creer les 8 index spatiaux GIST du projet : les
// colonnes de geometrie sont typees `Unsupported(...)` en Prisma (limitation
// du schema Prisma lui-meme, pas de `db push`), donc aucun index dessus ne
// peut etre exprime dans schema.prisma — seules les migrations SQL manuelles
// (`prisma/migrations/**/migration.sql`) les contenaient jusqu'ici, et `db
// push` ne les rejoue jamais. Consequence si on ne fait rien : chaque table
// geometrique se retrouve creee SANS son index GIST, invisible sur une base
// vide de smoke-test mais catastrophique en usage reel (jointures spatiales
// sur des dizaines/centaines de milliers de parcelles qui degenerent en scan
// sequentiel). Ces `CREATE INDEX IF NOT EXISTS` sont executes a CHAQUE
// lancement (pas seulement le premier) : idempotents par construction, et
// auto-reparateurs si une future mise a jour de l'app par `db push
// --accept-data-loss` supprimait un jour l'un de ces index en modifiant le
// schema.
function creerIndexSpatiaux(port: number): void {
  const instructions = [
    'CREATE INDEX IF NOT EXISTS "Parcelle_geom_idx" ON "Parcelle" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "cad_communes_2013_geom_idx" ON "cad_communes_2013" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "cad_communes_2026_geom_idx" ON "cad_communes_2026" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "cad_sections_geom_idx" ON "cad_sections" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "cad_parcelles_geom_idx" ON "cad_parcelles" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "limite_section_geom_idx" ON "limite_section" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "cad_arrondissements_geom_idx" ON "cad_arrondissements" USING GIST ("geom");',
    'CREATE INDEX IF NOT EXISTS "cad_verifications_geom_idx" ON "cad_verifications" USING GIST ("geom");',
  ].join(" ");
  const resultat = executerPsql(port, ["-d", "geoaino", "-c", instructions]);
  if (resultat.status !== 0) {
    throw new Error(`Creation des index spatiaux echouee : ${resultat.stderr?.toString()}`);
  }
}

/**
 * Cree un compte ADMIN initial si la base ne contient encore aucun
 * utilisateur (premier lancement seulement) — sans ca, l'operateur n'a
 * aucun moyen de se connecter a une installation neuve (spec, § Cycle de
 * demarrage). Insertion SQL directe plutot que via Prisma Client : le
 * process principal Electron n'a besoin d'aucune autre dependance a
 * Prisma que le CLI deja invoque pour la synchronisation du schema (cf.
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

/**
 * Verifie qu'une licence valide est presente pour CETTE machine avant tout
 * demarrage de Postgres/Next (cf. spec cle d'activation) — boucle de
 * dialogues natifs (meme pattern que les identifiants admin plus bas) tant
 * qu'aucune licence valide n'est importee. Renvoie `false` si l'utilisateur
 * a choisi de quitter (`app.quit()` deja appele : `demarrerApplication` ne
 * doit alors PAS continuer).
 */
function assurerLicenceActivee(): boolean {
  const empreinte = empreinteMachine();
  let licence = chargerLicenceEnregistree();

  while (!licenceEstValide(licence)) {
    const choix = dialog.showMessageBoxSync({
      type: "info",
      title: "Activation requise",
      message: "Cette installation n'est pas activee.",
      detail:
        `Empreinte de cette machine :\n${empreinte}\n\n` +
        "Transmettez ce code a votre fournisseur pour obtenir votre fichier " +
        "de licence (.geoaino), puis importez-le ci-dessous.",
      buttons: ["Importer une licence", "Quitter"],
      defaultId: 0,
      cancelId: 1,
    });

    if (choix === 1) {
      app.quit();
      return false;
    }

    const fichiers = dialog.showOpenDialogSync({
      title: "Selectionner le fichier de licence",
      filters: [{ name: "Licence GeoAino", extensions: ["geoaino"] }],
      properties: ["openFile"],
    });
    if (!fichiers || fichiers.length === 0) continue; // annule -> reboucle sur le message

    try {
      const candidate = JSON.parse(readFileSync(fichiers[0], "utf8")) as Licence;
      if (licenceEstValide(candidate)) {
        enregistrerLicence(candidate);
        licence = candidate;
        continue; // la boucle while re-teste licenceEstValide(licence) -> sort cette fois
      }
      dialog.showErrorBox(
        "Licence invalide",
        "Fichier de licence invalide ou ne correspondant pas a cette machine.",
      );
    } catch {
      dialog.showErrorBox(
        "Licence invalide",
        "Fichier de licence invalide ou ne correspondant pas a cette machine.",
      );
    }
  }
  return true;
}

async function demarrerApplication(): Promise<void> {
  if (!assurerLicenceActivee()) return;

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
  creerIndexSpatiaux(clusterPg.port);

  const identifiantsInitiaux = await amorcerCompteAdmin(clusterPg.port);
  if (identifiantsInitiaux) {
    // Filet de secours pour un operateur non technicien qui lirait mal le
    // mot de passe affiche une seule fois ci-dessous : sans cette copie sur
    // disque, la seule recuperation possible etait de reinitialiser tout
    // `pgdata` (perte de donnees). Ce n'est pas un enjeu de securite au-dela
    // de ce que la boite de dialogue expose deja — quiconque a acces a
    // `%APPDATA%\GeoAino` a de toute facon deja acces complet au repertoire
    // de donnees Postgres local.
    const cheminIdentifiants = cheminIdentifiantsInitiaux();
    // `mode: 0o600` : restreint la lecture/ecriture au seul proprietaire du
    // fichier — correct et significatif si ce code tourne un jour sous
    // WSL/POSIX, mais un no-op de fait sur NTFS natif Windows (qui n'utilise
    // pas les bits POSIX ; une vraie restriction demanderait un appel ACL
    // separe via `icacls`/PowerShell, hors perimetre de ce seul fichier vu
    // que `dossierDonnees()` entier — `auth.secret`, `pgdata` — partage deja
    // la meme absence de durcissement aujourd'hui). Best-effort assume, pas
    // une garantie sur Windows.
    writeFileSync(
      cheminIdentifiants,
      `Identifiants administrateur initiaux (GeoAino)\n${identifiantsInitiaux}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    dialog.showMessageBoxSync({
      type: "info",
      title: "Compte administrateur cree",
      message: "Un compte administrateur a ete cree pour cette installation.",
      detail:
        `Identifiants (a noter, non recuperables ensuite) :\n${identifiantsInitiaux}\n\n` +
        `Ces identifiants ont egalement ete enregistres dans :\n${cheminIdentifiants}`,
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
