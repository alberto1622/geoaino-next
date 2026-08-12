import assert from "node:assert";
import { runShapefileImportJob } from "../src/lib/import/run-shapefile-job";

assert.strictEqual(typeof runShapefileImportJob, "function");

const jobIdArg = process.argv[2];
if (!jobIdArg) {
  console.log(
    "SKIP: fournir un id de job existant (pending, sourceType SHP) en argument pour l'exécuter réellement — " +
      "ex: bun run scripts/test-run-shapefile-job.ts 42",
  );
  process.exit(0);
}

await runShapefileImportJob(Number(jobIdArg));
console.log(`OK: runShapefileImportJob(${jobIdArg}) a terminé sans lever d'exception — vérifier son statut via GET /api/import-jobs/${jobIdArg}`);
