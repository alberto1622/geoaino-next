import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { trouverPortLibre } from "./port-utils";

export type ClusterPostgres = {
  port: number;
  arreter: () => Promise<void>;
};

/**
 * Un `postmaster.pid` present alors qu'aucun process n'ecoute plus dessus
 * (fermeture forcee precedente, crash) fait echouer `pg_ctl start` avec un
 * message trompeur (« un autre serveur tourne peut-etre »). On le detecte
 * en relisant le PID qu'il contient et en verifiant qu'aucun process
 * Windows ne le porte encore.
 */
function nettoyerVerrouOrphelin(dataDir: string): void {
  const lockfile = path.join(dataDir, "postmaster.pid");
  if (!existsSync(lockfile)) return;
  const pid = Number(readFileSync(lockfile, "utf8").split("\n")[0]);
  if (!Number.isFinite(pid)) return;
  const tasklist = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
  const processVivant = tasklist.stdout?.toString().includes(String(pid));
  if (!processVivant) rmSync(lockfile, { force: true });
}

async function attendrePret(binDir: string, port: number, delaiMaxMs = 15_000): Promise<void> {
  const pgIsReady = path.join(binDir, "pg_isready.exe");
  const debut = Date.now();
  while (Date.now() - debut < delaiMaxMs) {
    const res = spawnSync(pgIsReady, ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"]);
    if (res.status === 0) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`PostgreSQL local n'a pas repondu dans les ${delaiMaxMs}ms suivant son demarrage.`);
}

/**
 * Demarre (en l'initialisant si besoin) un cluster PostgreSQL/PostGIS
 * portable local, ecoutant uniquement sur 127.0.0.1.
 */
export async function demarrerPostgresPortable(options: {
  binDir: string;
  dataDir: string;
  candidatsPort: number[];
}): Promise<ClusterPostgres> {
  const { binDir, dataDir, candidatsPort } = options;
  const initdb = path.join(binDir, "initdb.exe");
  const pgCtl = path.join(binDir, "pg_ctl.exe");

  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    mkdirSync(dataDir, { recursive: true });
    const init = spawnSync(initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8"]);
    if (init.status !== 0) {
      throw new Error(`initdb a echoue : ${init.stderr?.toString()}`);
    }
  }

  nettoyerVerrouOrphelin(dataDir);
  const port = await trouverPortLibre(candidatsPort);

  // `pg_ctl start` lance postgres.exe comme process detache de longue duree,
  // qui herite du tube stdout/stderr de pg_ctl. Comme ce serveur ne se
  // termine jamais, l'extremite d'ecriture du tube ne se ferme jamais non
  // plus, et `spawnSync` (qui lit ses tubes jusqu'a EOF) reste bloque pour
  // toujours des que pg_ctl a reussi — meme si pg_ctl lui-meme s'est deja
  // termine. `stdio: "ignore"` evite tout tube ; ne pas le retirer sans
  // relire ce commentaire.
  const start = spawnSync(pgCtl, [
    "-D", dataDir,
    "-l", path.join(dataDir, "server.log"),
    "-o", `-p ${port} -c listen_addresses=127.0.0.1`,
    "start",
  ], { stdio: "ignore" });
  if (start.status !== 0) {
    throw new Error(`pg_ctl start a echoue (voir ${path.join(dataDir, "server.log")}).`);
  }
  try {
    await attendrePret(binDir, port);
  } catch (e) {
    // `pg_ctl start` a reussi (le process postgres.exe tourne) mais
    // `attendrePret` a expire avant que le serveur ne reponde : sans cet
    // arret explicite, ce process reste orphelin (jamais assigne a
    // `clusterPg` dans main.ts, donc invisible au nettoyage de
    // `before-quit`). Au prochain lancement, `nettoyerVerrouOrphelin`
    // constate a raison que le PID du verrou est toujours vivant et refuse
    // de le supprimer : `pg_ctl start` echoue alors identiquement a chaque
    // tentative suivante, ce qui brique l'installation jusqu'a un kill
    // manuel via le Gestionnaire des taches. On arrete donc le cluster
    // qu'on vient de demarrer avant de propager l'erreur.
    spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    throw e;
  }

  return {
    port,
    arreter: async () => {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "stop"], { stdio: "ignore" });
    },
  };
}
