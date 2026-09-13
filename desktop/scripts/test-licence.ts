import { generateKeyPairSync, sign } from "node:crypto";
import { messageCanonique, verifierSignature, type Licence } from "../src/licence-format";

let echecs = 0;
function verifier(condition: boolean, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    echecs++;
    console.error(`  ✗ ${message}`);
  }
}

// Paire de cles JETABLE pour ce test — sans rapport avec la vraie cle du
// vendeur (module-privee dans licence.ts) : verifierSignature() prend la
// cle publique en parametre explicite pour rester testable ainsi.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const clePubliquePem = publicKey.export({ type: "spki", format: "pem" }).toString();

function signerPourTest(donnees: Omit<Licence, "signature">): Licence {
  const message = Buffer.from(messageCanonique(donnees), "utf8");
  const signature = sign(null, message, privateKey).toString("base64");
  return { ...donnees, signature };
}

const licenceValide = signerPourTest({
  machineId: "MACHINE-TEST",
  client: "Client Test",
  emisLe: "2026-01-01T00:00:00.000Z",
});

console.log("[1] Licence valide acceptee");
verifier(
  verifierSignature(licenceValide, clePubliquePem, "MACHINE-TEST") === true,
  "signature correcte + bonne machine -> acceptee",
);

console.log("[2] Signature falsifiee rejetee");
const signatureAlteree: Licence = { ...licenceValide, signature: licenceValide.signature.slice(0, -4) + "AAAA" };
verifier(
  verifierSignature(signatureAlteree, clePubliquePem, "MACHINE-TEST") === false,
  "signature modifiee -> rejetee",
);

console.log("[3] Contenu modifie après signature rejeté");
const contenuAltere: Licence = { ...licenceValide, client: "Client Pirate" };
verifier(
  verifierSignature(contenuAltere, clePubliquePem, "MACHINE-TEST") === false,
  "client modifie apres coup -> rejetee (signature ne correspond plus au contenu)",
);

console.log("[4] Bonne signature mais mauvaise machine rejetée");
verifier(
  verifierSignature(licenceValide, clePubliquePem, "AUTRE-MACHINE") === false,
  "empreinte locale differente de licence.machineId -> rejetee",
);

console.log("[5] Signée par une autre clé rejetée");
const { publicKey: autreClePublique } = generateKeyPairSync("ed25519");
const autreClePubliquePem = autreClePublique.export({ type: "spki", format: "pem" }).toString();
verifier(
  verifierSignature(licenceValide, autreClePubliquePem, "MACHINE-TEST") === false,
  "verifiee avec une cle publique differente de celle qui a signe -> rejetee",
);

console.log(`\n${echecs === 0 ? "Tous les tests OK" : `${echecs} echec(s)`}`);
process.exit(echecs === 0 ? 0 : 1);
