import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";

export type ServeurNext = {
  processus: ChildProcess;
  arreter: () => Promise<void>;
};

/**
 * Demarre le build `output: standalone` (server.js) comme process enfant,
 * avec l'environnement runtime deja calcule (DATABASE_URL, ports, etc. —
 * cf. runtime-env.ts). `cheminServeur` pointe vers
 * `<resources>/app/server.js` (cf. Task 10, extraResources).
 */
export function demarrerNextStandalone(options: {
  cheminServeur: string;
  env: NodeJS.ProcessEnv;
  fichierLog: string;
}): ServeurNext {
  const log = createWriteStream(options.fichierLog, { flags: "a" });
  const processus = spawn(process.execPath, [options.cheminServeur], {
    cwd: path.dirname(options.cheminServeur),
    env: options.env,
    windowsHide: true,
  });
  processus.stdout?.pipe(log);
  processus.stderr?.pipe(log);

  return {
    processus,
    arreter: () =>
      new Promise((resolve) => {
        processus.once("exit", () => resolve());
        processus.kill();
        setTimeout(resolve, 3000); // filet de securite si l'arret propre traine
      }),
  };
}

/** Sonde `http://127.0.0.1:<port>` jusqu'a obtenir une reponse HTTP. */
export async function attendreServeurPret(port: number, delaiMaxMs = 20_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < delaiMaxMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`);
      if (res.status < 500) return;
    } catch {
      // pas encore pret
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Le serveur Next.js local n'a pas repondu dans les ${delaiMaxMs}ms.`);
}
