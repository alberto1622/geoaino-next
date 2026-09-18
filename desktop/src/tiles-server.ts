import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { trouverPortLibre } from "./port-utils";

export interface ServeurTuiles {
  port: number;
  arreter(): Promise<void>;
}

/**
 * Démarre tileserver-gl en tant que processus enfant Node.js dédié.
 * Le binaire est embarqué dans `desktop/vendor/tileserver/` (copié dans
 * `resources/tileserver` lors du packaging par electron-builder) et utilise
 * les modules natifs (sqlite3) résolus via le node_modules local au vendor.
 */
export async function demarrerServeurTuiles(): Promise<ServeurTuiles> {
  const port = await trouverPortLibre([8081, 8082, 8083, 8084, 8085]);

  // En dev (desktop/src/), le vendor est à desktop/vendor/tileserver.
  // En production packagé, electron-builder copie dans resources/tileserver.
  const baseDir = process.versions.electron
    ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
    : path.resolve(__dirname, "..", "..", "vendor");
  const cheminVendor = path.join(baseDir, "tileserver");
  const cheminMain = path.join(cheminVendor, "tileserver-gl", "src", "main.js");

  // tileserver-gl nécessite un répertoire de travail contenant les tuiles
  // par défaut (public/ fonts/ styles/).
  const cwdTileserver = path.join(cheminVendor, "tileserver-gl");

  // config.json vit dans le dossier tileserver-gl ; on le résout absolument
  // car path.resolve() dans main.js dépend de process.cwd().
  const configPath = path.join(cwdTileserver, "config.json");

  const spawnOptions = {
    cwd: cwdTileserver,
    env: {
      ...process.env,
      NODE_PATH: path.join(cheminVendor, "node_modules"),
    },
    stdio: ["pipe", "pipe", "pipe"] as SpawnOptions["stdio"],
  };

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cheminMain,
        "--config", configPath,
        "--bind", "127.0.0.1",
        "--port", String(port),
        "--silent",
      ],
      spawnOptions,
    ) as ChildProcessWithoutNullStreams;

    let timeoutFini = false;
    const timeout = setTimeout(() => {
      timeoutFini = true;
      child.kill();
      reject(new Error("tileserver-gl n'a pas demarre dans les 15 secondes"));
    }, 15_000);

    child.stdout.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Listening") || msg.includes("Startup complete")) {
        clearTimeout(timeout);
        resolve({
          port,
          arreter: () => {
            return new Promise((res) => {
              child.kill();
              child.on("exit", () => res());
            });
          },
        });
      }
    });

    child.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Error") || msg.includes("error:")) {
        clearTimeout(timeout);
        child.kill();
        reject(new Error(`tileserver-gl : ${msg}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Echec du lancement de tileserver-gl : ${err.message}`));
    });

    child.on("exit", (code) => {
      if (code !== 0 && code !== null && !timeoutFini) {
        clearTimeout(timeout);
        reject(new Error(`tileserver-gl s'est arrete inopinement (code ${code})`));
      }
    });
  });
}
