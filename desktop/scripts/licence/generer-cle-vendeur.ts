import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const cheminClePrivee = path.join(__dirname, "cle-privee-vendeur.pem");

if (existsSync(cheminClePrivee)) {
  console.error(
    `Une cle privee existe deja : ${cheminClePrivee}\n` +
      "Ce script ne doit etre lance qu'UNE SEULE FOIS : le relancer genererait " +
      "une nouvelle paire et invaliderait TOUTES les licences deja emises avec " +
      "l'ancienne cle publique embarquee dans l'app. Supprimez ce fichier " +
      "manuellement si vous voulez vraiment regenerer une nouvelle paire " +
      "(implique de republier l'app avec la nouvelle cle publique).",
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const clePriveePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const clePubliquePem = publicKey.export({ type: "spki", format: "pem" }).toString();

writeFileSync(cheminClePrivee, clePriveePem, { encoding: "utf8", mode: 0o600 });

console.log(`Cle privee ecrite dans : ${cheminClePrivee}`);
console.log("A CONSERVER PRECIEUSEMENT, HORS DU DEPOT GIT — NE JAMAIS LA COMMITTER NI LA PARTAGER.\n");
console.log("Colle EXACTEMENT ce qui suit dans CLE_PUBLIQUE_VENDEUR_PEM (desktop/src/licence.ts) :\n");
console.log(clePubliquePem);
