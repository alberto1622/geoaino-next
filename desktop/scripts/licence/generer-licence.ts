import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { messageCanonique, type Licence } from "../../src/licence-format";

const [, , machineId, client] = process.argv;
if (!machineId || !client) {
  console.error("Usage : npx tsx desktop/scripts/licence/generer-licence.ts <machineId> <client>");
  console.error('Exemple : npx tsx desktop/scripts/licence/generer-licence.ts "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX" "Mairie de Thies"');
  process.exit(1);
}

const cheminClePrivee =
  process.env.GEOAINO_CLE_PRIVEE_VENDEUR ??
  path.join(os.homedir(), ".geoaino-vendeur", "cle-privee-vendeur.pem");
const clePrivee = createPrivateKey(readFileSync(cheminClePrivee, "utf8"));

const emisLe = new Date().toISOString();
const message = Buffer.from(messageCanonique({ machineId, client, emisLe }), "utf8");
const signature = sign(null, message, clePrivee).toString("base64");

const licence: Licence = { machineId, client, emisLe, signature };
const nomFichier = `licence-${client.replace(/[^a-zA-Z0-9_-]+/g, "_")}.geoaino`;
writeFileSync(nomFichier, JSON.stringify(licence, null, 2), "utf8");

console.log(`Licence ecrite : ${nomFichier}`);
console.log("A transmettre au client (email, cle USB...).");
