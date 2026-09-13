import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Alphabet Crockford (base32 sans caracteres ambigus : ni I/L/O — confondus
// avec 1/1/0 — ni U — evite de former des mots avec V). Standard etabli,
// pas invente ici.
const ALPHABET_BASE32_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encoderBase32Crockford(buffer: Buffer): string {
  let bits = "";
  for (const octet of buffer) bits += octet.toString(2).padStart(8, "0");
  while (bits.length % 5 !== 0) bits += "0"; // complete le dernier groupe de 5 bits
  let resultat = "";
  for (let i = 0; i < bits.length; i += 5) {
    resultat += ALPHABET_BASE32_CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  }
  return resultat;
}

function grouperParBlocs(chaine: string, taille = 4): string {
  const blocs: string[] = [];
  for (let i = 0; i < chaine.length; i += taille) blocs.push(chaine.slice(i, i + taille));
  return blocs.join("-");
}

/**
 * Transforme un GUID Windows en empreinte affichable — separee de
 * `empreinteMachine()` pour rester testable sans toucher au registre
 * Windows (cf. desktop/scripts/test-machine-id.ts).
 */
export function empreinteDepuisGuid(guid: string): string {
  const hash = createHash("sha256").update(guid).digest();
  // 16 premiers octets (128 bits) : largement suffisant pour l'unicite
  // recherchee ici, tout en gardant l'empreinte affichee courte (26
  // caracteres/7 blocs) — transmissible par telephone/email sans erreur.
  return grouperParBlocs(encoderBase32Crockford(hash.subarray(0, 16)));
}

function lireMachineGuid(): string {
  // `reg.exe` est un binaire Windows natif independant (pas cmd.exe ni
  // powershell.exe) — evite deliberement toute dependance a un shell.
  const sortie = execFileSync("reg", [
    "query",
    "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
    "/v",
    "MachineGuid",
  ]).toString();
  const correspondance = sortie.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
  if (!correspondance) {
    throw new Error("MachineGuid introuvable dans le registre Windows (sortie reg.exe inattendue).");
  }
  return correspondance[1];
}

/** Empreinte de CETTE machine, stable tant que Windows n'est pas reinstalle. */
export function empreinteMachine(): string {
  return empreinteDepuisGuid(lireMachineGuid());
}
