import { readFileSync } from "node:fs";
import { verifierSignature, CLE_PUBLIQUE_VENDEUR_PEM, type Licence } from "../../src/licence";

const [, , cheminFichier] = process.argv;
if (!cheminFichier) {
  console.error("Usage : npx tsx desktop/scripts/licence/verifier-licence.ts <fichier.geoaino>");
  process.exit(1);
}

const licence = JSON.parse(readFileSync(cheminFichier, "utf8")) as Licence;
// Utilise licence.machineId lui-meme comme "empreinte locale" : ce script
// verifie uniquement que la SIGNATURE est correcte pour le contenu du
// fichier, pas qu'on tourne sur la machine ciblee (impossible depuis la
// machine du vendeur, et ce n'est pas le but ici).
const valide = verifierSignature(licence, CLE_PUBLIQUE_VENDEUR_PEM, licence.machineId);
console.log(valide ? "Licence valide (signature correcte)." : "LICENCE INVALIDE — ne pas transmettre au client.");
process.exit(valide ? 0 : 1);
