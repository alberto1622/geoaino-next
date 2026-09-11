//
// Necessite un bundle assemble par assemble-pg-portable.ps1 (Task 1) ;
// ignore sinon, comme les tests dependant d'une ressource externe
// optionnelle dans scripts/test-verif.ts.
//
// Usage : npx tsx desktop/scripts/test-postgres-manager.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { demarrerPostgresPortable } from "../src/postgres-manager";

let ok = 0;
let ko = 0;
function check(nom: string, condition: boolean, detail?: string) {
  if (condition) {
    ok++;
    console.log(`  ✓ ${nom}`);
  } else {
    ko++;
    console.error(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const binDir = path.resolve(__dirname, "../vendor/pg-portable/bin");
  if (!existsSync(binDir)) {
    console.log("(desktop/vendor/pg-portable absent — executer assemble-pg-portable.ps1 d'abord ; test ignore)");
    return;
  }

  const candidatsPort = [54329, 54330, 54331];
  const dataDir = mkdtempSync(path.join(tmpdir(), "geoaino-pg-test-"));
  const psql = path.join(binDir, "psql.exe");

  console.log("\n[1] Demarrage a froid");
  const cluster = await demarrerPostgresPortable({ binDir, dataDir, candidatsPort });
  check("un port est retenu", candidatsPort.includes(cluster.port), String(cluster.port));

  const req = spawnSync(psql, ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", "postgres", "-c", "SELECT 1;"]);
  check("le cluster repond a une requete", req.status === 0, req.stderr?.toString());

  console.log("\n[2] Recuperation d'un verrou orphelin (process tue de force)");
  const pidFile = path.join(dataDir, "postmaster.pid");
  const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
  spawnSync("taskkill", ["/PID", String(pid), "/F"]);
  await new Promise((r) => setTimeout(r, 500));

  let erreurRedemarrage: unknown = null;
  let clusterApresCrash: Awaited<ReturnType<typeof demarrerPostgresPortable>> | null = null;
  try {
    clusterApresCrash = await demarrerPostgresPortable({ binDir, dataDir, candidatsPort });
  } catch (e) {
    erreurRedemarrage = e;
  }
  check(
    "redemarrage apres verrou orphelin sans erreur",
    erreurRedemarrage === null,
    erreurRedemarrage instanceof Error ? erreurRedemarrage.message : String(erreurRedemarrage),
  );

  if (clusterApresCrash) await clusterApresCrash.arreter();
  rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n${ok} assertion(s) OK, ${ko} en echec.`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
