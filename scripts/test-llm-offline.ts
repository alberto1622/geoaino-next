//
// Teste la detection d'erreur reseau en pur (aucun appel reseau reel) :
// usage : npx tsx scripts/test-llm-offline.ts
import { estErreurReseau, LLMIndisponibleError } from "../src/lib/llm";

let ok = 0;
let ko = 0;
function check(nom: string, condition: boolean) {
  if (condition) {
    ok++;
    console.log(`  ✓ ${nom}`);
  } else {
    ko++;
    console.error(`  ✗ ${nom}`);
  }
}

check(
  "ENOTFOUND detecte comme erreur reseau",
  estErreurReseau(Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" })),
);
check(
  "ECONNREFUSED (cause imbriquee, fetch natif) detecte",
  estErreurReseau(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
);
check(
  "erreur applicative (401) NON traitee comme reseau",
  !estErreurReseau(Object.assign(new Error("Unauthorized"), { status: 401 })),
);
check("LLMIndisponibleError porte un message clair", new LLMIndisponibleError().message.includes("connexion internet"));

console.log(`\n${ok} assertion(s) OK, ${ko} en echec.`);
process.exit(ko === 0 ? 0 : 1);
