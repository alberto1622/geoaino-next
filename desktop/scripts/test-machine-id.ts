import { empreinteDepuisGuid } from "../src/machine-id";

let echecs = 0;
function verifier(condition: boolean, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    echecs++;
    console.error(`  ✗ ${message}`);
  }
}

console.log("[1] Format de l'empreinte");
const empreinte = empreinteDepuisGuid("11111111-1111-1111-1111-111111111111");
verifier(/^[0-9A-Z-]+$/.test(empreinte), "ne contient que majuscules/chiffres/tirets");
verifier(!/[ILOU]/.test(empreinte.replace(/-/g, "")), "aucun caractere ambigu (I, L, O, U — hors alphabet Crockford)");
verifier(
  empreinte.split("-").every((bloc) => bloc.length <= 4),
  "blocs de 4 caracteres maximum",
);

console.log("[2] Déterminisme");
verifier(
  empreinteDepuisGuid("11111111-1111-1111-1111-111111111111") === empreinte,
  "meme GUID -> meme empreinte a chaque appel",
);

console.log("[3] Unicité");
verifier(
  empreinteDepuisGuid("22222222-2222-2222-2222-222222222222") !== empreinte,
  "GUID different -> empreinte differente",
);

console.log(`\n${echecs === 0 ? "Tous les tests OK" : `${echecs} echec(s)`}`);
process.exit(echecs === 0 ? 0 : 1);
