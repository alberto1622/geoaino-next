import { createPublicKey, verify } from "node:crypto";

export type Licence = {
  machineId: string;
  client: string;
  emisLe: string;
  signature: string;
};

/**
 * Cle publique Ed25519 du vendeur — generee une seule fois par
 * `desktop/scripts/licence/generer-cle-vendeur.ts` (Task 3, cf.
 * docs/BUREAU-AUTONOME.md). Une cle PUBLIQUE n'a pas besoin d'etre secrete :
 * elle peut etre committee sans risque, contrairement a la cle privee
 * correspondante qui ne doit JAMAIS quitter la machine du vendeur ni etre
 * embarquee dans l'installateur. Si ce champ redevient vide un jour,
 * `licenceEstValide` rejette alors systematiquement (createPublicKey("")
 * leve) — comportement surattendu tant qu'aucune vraie cle n'est branchee.
 */
export const CLE_PUBLIQUE_VENDEUR_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdrmov2p1AeUeLs63FHVW4XUlU8nQJismN+s4VisWTwY=
-----END PUBLIC KEY-----
`;

/**
 * Serialisation deterministe utilisee a la fois pour signer (outillage
 * vendeur, Task 3) et pour verifier (ici) — cles explicitement enumerees
 * (pas de spread de l'objet source) pour garantir un ordre de cles stable :
 * sinon une signature generee par le vendeur pourrait ne plus correspondre
 * au message reconstruit ici si l'ordre d'insertion differait.
 */
export function messageCanonique(donnees: Pick<Licence, "machineId" | "client" | "emisLe">): string {
  return JSON.stringify({
    machineId: donnees.machineId,
    client: donnees.client,
    emisLe: donnees.emisLe,
  });
}

/**
 * Verifie une licence contre une cle publique et une empreinte machine
 * DONNEES EN PARAMETRE — separee de `licenceEstValide` (qui utilise la
 * vraie cle embarquee + la vraie machine locale) pour rester testable avec
 * une paire de cles jetable, sans toucher au registre Windows.
 */
export function verifierSignature(licence: Licence, clePubliquePem: string, empreinteLocale: string): boolean {
  if (licence.machineId !== empreinteLocale) return false;
  try {
    const clePublique = createPublicKey(clePubliquePem);
    const message = Buffer.from(messageCanonique(licence), "utf8");
    const signature = Buffer.from(licence.signature, "base64");
    return verify(null, message, clePublique, signature);
  } catch {
    return false;
  }
}
