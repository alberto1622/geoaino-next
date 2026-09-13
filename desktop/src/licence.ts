import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cheminLicence } from "./runtime-env";
import { empreinteMachine } from "./machine-id";
import { verifierSignature, CLE_PUBLIQUE_VENDEUR_PEM, type Licence } from "./licence-format";

export type { Licence } from "./licence-format";
export { messageCanonique, verifierSignature, CLE_PUBLIQUE_VENDEUR_PEM } from "./licence-format";

/** Relit la licence persistee (`%APPDATA%\GeoAino\licence.dat`), ou `null` si absente/illisible. */
export function chargerLicenceEnregistree(): Licence | null {
  const chemin = cheminLicence();
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, "utf8")) as Licence;
  } catch {
    return null;
  }
}

export function enregistrerLicence(licence: Licence): void {
  writeFileSync(cheminLicence(), JSON.stringify(licence), "utf8");
}

/** Verifie une licence contre la vraie cle du vendeur et la vraie machine locale. */
export function licenceEstValide(licence: Licence | null): boolean {
  if (!licence) return false;
  return verifierSignature(licence, CLE_PUBLIQUE_VENDEUR_PEM, empreinteMachine());
}
