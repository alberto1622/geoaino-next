# Clé d'activation du bureau autonome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empêcher qu'un installateur du bureau autonome GeoAino serve à activer plus de postes que prévu, via une licence signée liée à une machine précise, vérifiée entièrement hors ligne.

**Architecture:** Une empreinte dérivée du `MachineGuid` Windows identifie chaque poste. Le vendeur signe un petit fichier JSON (`.geoaino`) pour cette empreinte avec une clé privée Ed25519 gardée hors du dépôt ; l'app embarque uniquement la clé publique correspondante et revérifie la signature + l'empreinte à **chaque** lancement, avant tout démarrage de Postgres/Next. Aucun appel réseau, aucune expiration.

**Tech Stack:** `node:crypto` (Ed25519, natif — aucune nouvelle dépendance npm), `node:child_process` (`reg.exe query`), Electron `dialog` (boîtes natives, même pattern que les identifiants admin existants).

**Spec:** [`docs/superpowers/specs/2026-09-13-cle-activation-desktop-design.md`](../specs/2026-09-13-cle-activation-desktop-design.md)

## Global Constraints

- Vérification de licence **100% locale, aucun appel réseau, jamais**.
- Une licence n'active **qu'une seule machine** précise (empreinte `MachineGuid`).
- Licence **perpétuelle** une fois activée — pas de date d'expiration encodée.
- Remise au client sous forme de **fichier `.geoaino` à importer** — jamais un code tapé à la main.
- Signature **Ed25519 asymétrique** — clé privée jamais committée, jamais embarquée dans l'installateur ; clé publique embarquée en dur (elle n'a pas besoin d'être secrète).
- Tout message d'erreur d'activation reste **générique** (ne jamais distinguer « mauvaise machine » de « signature invalide » dans l'interface).
- La vérification tourne **avant** `demarrerPostgresPortable()`, à **chaque** lancement (pas seulement au premier).

---

### Task 1: Empreinte machine (`desktop/src/machine-id.ts`)

**Files:**
- Create: `desktop/src/machine-id.ts`
- Test: `desktop/scripts/test-machine-id.ts`

**Interfaces:**
- Produces: `empreinteDepuisGuid(guid: string): string` (pure, testable sans registre) ; `empreinteMachine(): string` (lit le vrai `MachineGuid` de cette machine).

- [ ] **Step 1: Écrire `desktop/src/machine-id.ts`**

```typescript
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
```

- [ ] **Step 2: Écrire le test `desktop/scripts/test-machine-id.ts`**

```typescript
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
```

- [ ] **Step 3: Lancer le test**

Run: `npx tsx desktop/scripts/test-machine-id.ts`
Expected: `Tous les tests OK`, code de sortie 0.

- [ ] **Step 4: Vérifier que la lecture réelle du registre fonctionne sur cette machine**

Run (ligne de commande temporaire, ne rien committer) :
```bash
npx tsx -e "import('./desktop/src/machine-id.js').catch(()=>import('./desktop/src/machine-id.ts')).then(m=>console.log(m.empreinteMachine()))"
```
Si cette commande échoue à cause du chargement dynamique, créer temporairement
un fichier `desktop/scripts/_verifier-empreinte.ts` :
```typescript
import { empreinteMachine } from "../src/machine-id";
console.log(empreinteMachine());
```
Run: `npx tsx desktop/scripts/_verifier-empreinte.ts`
Expected: une empreinte de la forme `XXXX-XXXX-XXXX-...` s'affiche, sans
erreur. Supprimer ensuite ce fichier temporaire (`rm desktop/scripts/_verifier-empreinte.ts`) — il ne fait pas partie du plan, il sert uniquement à confirmer que `reg.exe` répond sur cette machine de dev avant de continuer.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/machine-id.ts desktop/scripts/test-machine-id.ts
git commit -m "feat(desktop): empreinte machine pour la cle d'activation"
```

---

### Task 2: Format et vérification de licence (`desktop/src/licence.ts`)

**Files:**
- Modify: `desktop/src/runtime-env.ts`
- Create: `desktop/src/licence.ts`
- Test: `desktop/scripts/test-licence.ts`

**Interfaces:**
- Consumes: `empreinteMachine(): string` (Task 1, `./machine-id`).
- Produces: `type Licence = { machineId: string; client: string; emisLe: string; signature: string }` ; `messageCanonique(donnees: Pick<Licence,"machineId"|"client"|"emisLe">): string` ; `verifierSignature(licence: Licence, clePubliquePem: string, empreinteLocale: string): boolean` ; `chargerLicenceEnregistree(): Licence | null` ; `enregistrerLicence(licence: Licence): void` ; `licenceEstValide(licence: Licence | null): boolean` ; `CLE_PUBLIQUE_VENDEUR_PEM: string` (vide à l'issue de cette tâche, remplie Task 3).

- [ ] **Step 1: Ajouter `cheminLicence()` dans `desktop/src/runtime-env.ts`**

Ajouter cette fonction juste après `cheminIdentifiantsInitiaux` (ligne 35 actuelle) :

```typescript
/** Chemin de la licence d'activation persistee (revalidee a chaque lancement). */
export function cheminLicence(): string {
  return path.join(dossierDonnees(), "licence.dat");
}
```

- [ ] **Step 2: Écrire le test `desktop/scripts/test-licence.ts` (avant l'implémentation — il échouera, c'est attendu)**

```typescript
import { generateKeyPairSync, sign } from "node:crypto";
import { messageCanonique, verifierSignature, type Licence } from "../src/licence";

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
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue (module `licence.ts` inexistant)**

Run: `npx tsx desktop/scripts/test-licence.ts`
Expected: échec au chargement du module (`Cannot find module '../src/licence'`).

- [ ] **Step 4: Écrire `desktop/src/licence.ts`**

```typescript
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cheminLicence } from "./runtime-env";
import { empreinteMachine } from "./machine-id";

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
 * embarquee dans l'installateur. Vide jusqu'a Task 3 : `licenceEstValide`
 * rejette alors systematiquement (createPublicKey("") leve), ce qui est le
 * comportement surattendu tant qu'aucune vraie cle n'est branchee.
 */
export const CLE_PUBLIQUE_VENDEUR_PEM = "";

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
```

- [ ] **Step 5: Lancer le test pour vérifier qu'il passe**

Run: `npx tsx desktop/scripts/test-licence.ts`
Expected: `Tous les tests OK`, code de sortie 0 (les 5 cas testent `verifierSignature` directement — indépendant de `CLE_PUBLIQUE_VENDEUR_PEM`, encore vide à ce stade).

- [ ] **Step 6: Vérification TypeScript**

Run: `npx tsc -p desktop/tsconfig.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/runtime-env.ts desktop/src/licence.ts desktop/scripts/test-licence.ts
git commit -m "feat(desktop): format et verification de licence (Ed25519)"
```

---

### Task 3: Outillage vendeur (génération de clés et de licences)

**Files:**
- Create: `desktop/scripts/licence/generer-cle-vendeur.ts`
- Create: `desktop/scripts/licence/generer-licence.ts`
- Create: `desktop/scripts/licence/verifier-licence.ts`
- Modify: `desktop/src/licence.ts` (branchement de la vraie clé publique)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `messageCanonique`, `verifierSignature`, `CLE_PUBLIQUE_VENDEUR_PEM`, `type Licence` (Task 2, `../../src/licence`).
- Produces: aucune interface consommée par d'autres tâches — outillage terminal, utilisé par le vendeur en dehors du cycle de vie de l'app.

Ces trois scripts ne sont **jamais** embarqués dans l'installateur (ils
vivent hors de `desktop/src/`, jamais compilés par `npm run build:desktop`,
jamais listés dans `desktop/electron-builder.yml`) — exécutés uniquement par
le vendeur via `npx tsx`, sur sa propre machine.

- [ ] **Step 1: Étendre `.gitignore`**

Ajouter, après la ligne `*.pem` existante (déjà présente, couvre
`cle-privee-vendeur.pem` où qu'il soit dans le dépôt) :

```gitignore
# cle d'activation desktop : fichiers de licence generes localement (jamais
# a committer, qu'ils soient de test ou reels)
*.geoaino
```

- [ ] **Step 2: Écrire `desktop/scripts/licence/generer-cle-vendeur.ts`**

```typescript
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
```

- [ ] **Step 3: Lancer le script et brancher la vraie clé publique**

Run: `npx tsx desktop/scripts/licence/generer-cle-vendeur.ts`

Expected : le fichier `desktop/scripts/licence/cle-privee-vendeur.pem` est
créé, et un bloc PEM `-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----`
s'affiche dans la sortie.

Copier ce bloc exact (guillemets inclus dans un template literal, retours à
la ligne préservés) et l'utiliser pour remplacer, dans
`desktop/src/licence.ts`, la ligne :

```typescript
export const CLE_PUBLIQUE_VENDEUR_PEM = "";
```

par (exemple de forme — remplacer par le VRAI bloc affiché par le script) :

```typescript
export const CLE_PUBLIQUE_VENDEUR_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----
`;
```

- [ ] **Step 4: Écrire `desktop/scripts/licence/generer-licence.ts`**

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import path from "node:path";
import { messageCanonique, type Licence } from "../../src/licence";

const [, , machineId, client] = process.argv;
if (!machineId || !client) {
  console.error("Usage : npx tsx desktop/scripts/licence/generer-licence.ts <machineId> <client>");
  console.error('Exemple : npx tsx desktop/scripts/licence/generer-licence.ts "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX" "Mairie de Thies"');
  process.exit(1);
}

const cheminClePrivee = path.join(__dirname, "cle-privee-vendeur.pem");
const clePrivee = createPrivateKey(readFileSync(cheminClePrivee, "utf8"));

const emisLe = new Date().toISOString();
const message = Buffer.from(messageCanonique({ machineId, client, emisLe }), "utf8");
const signature = sign(null, message, clePrivee).toString("base64");

const licence: Licence = { machineId, client, emisLe, signature };
const nomFichier = `licence-${client.replace(/[^a-zA-Z0-9_-]+/g, "_")}.geoaino`;
writeFileSync(nomFichier, JSON.stringify(licence, null, 2), "utf8");

console.log(`Licence ecrite : ${nomFichier}`);
console.log("A transmettre au client (email, cle USB...).");
```

- [ ] **Step 5: Écrire `desktop/scripts/licence/verifier-licence.ts`**

Outil de contrôle avant envoi : vérifie qu'une licence fraîchement générée
est bien formée et correctement signée, sans avoir besoin d'être sur la
machine ciblée.

```typescript
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
```

- [ ] **Step 6: Test bout en bout de l'outillage vendeur**

Run:
```bash
npx tsx desktop/scripts/licence/generer-licence.ts "TEST-MACHINE-0001" "Client Test"
npx tsx desktop/scripts/licence/verifier-licence.ts licence-Client_Test.geoaino
```
Expected : `Licence valide (signature correcte).`, code de sortie 0.

Puis vérifier le rejet d'une licence altérée :
```bash
node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('licence-Client_Test.geoaino'));l.client='Autre';fs.writeFileSync('licence-Client_Test.geoaino',JSON.stringify(l,null,2));"
npx tsx desktop/scripts/licence/verifier-licence.ts licence-Client_Test.geoaino
```
Expected : `LICENCE INVALIDE — ne pas transmettre au client.`, code de sortie 1.

Supprimer le fichier de test généré (couvert par `.gitignore` mais autant
nettoyer) : `rm licence-Client_Test.geoaino`

- [ ] **Step 7: Vérification TypeScript et non-régression**

Run: `npx tsc -p desktop/tsconfig.json --noEmit`
Expected: aucune erreur.

Run: `npx tsx desktop/scripts/test-licence.ts`
Expected: toujours `Tous les tests OK` (ce test utilise sa propre paire de
clés jetable, indépendante de `CLE_PUBLIQUE_VENDEUR_PEM` — ne doit pas être
affecté par le branchement de la vraie clé).

- [ ] **Step 8: Commit**

```bash
git add .gitignore desktop/src/licence.ts desktop/scripts/licence/generer-cle-vendeur.ts desktop/scripts/licence/generer-licence.ts desktop/scripts/licence/verifier-licence.ts
git commit -m "feat(desktop): outillage vendeur (generation de cles et de licences)"
```

**Rappel avant de committer** : vérifier `git status` ne montre AUCUN fichier
`cle-privee-vendeur.pem` ni `*.geoaino` dans le diff — ces deux motifs sont
désormais ignorés, mais un `git add -A` aveugle sur un fichier déjà suivi
par erreur passerait outre. Ne committer que les 5 fichiers listés ci-dessus.

---

### Task 4: Intégration dans le cycle de démarrage (`desktop/src/main.ts`)

**Files:**
- Modify: `desktop/src/main.ts`

**Interfaces:**
- Consumes: `empreinteMachine()` (Task 1) ; `chargerLicenceEnregistree()`, `enregistrerLicence()`, `licenceEstValide()`, `type Licence` (Task 2).

- [ ] **Step 1: Ajouter les imports**

Modifier la ligne d'import `node:fs` existante (ligne 5) :

```typescript
import { readFileSync, writeFileSync } from "node:fs";
```

Ajouter après la ligne d'import de `runtime-env` (ligne 10) :

```typescript
import { empreinteMachine } from "./machine-id";
import { chargerLicenceEnregistree, enregistrerLicence, licenceEstValide, type Licence } from "./licence";
```

- [ ] **Step 2: Ajouter la fonction de gate d'activation**

Ajouter juste avant `async function demarrerApplication()` :

```typescript
/**
 * Verifie qu'une licence valide est presente pour CETTE machine avant tout
 * demarrage de Postgres/Next (cf. spec cle d'activation) — boucle de
 * dialogues natifs (meme pattern que les identifiants admin plus bas) tant
 * qu'aucune licence valide n'est importee. Renvoie `false` si l'utilisateur
 * a choisi de quitter (`app.quit()` deja appele : `demarrerApplication` ne
 * doit alors PAS continuer).
 */
function assurerLicenceActivee(): boolean {
  const empreinte = empreinteMachine();
  let licence = chargerLicenceEnregistree();

  while (!licenceEstValide(licence)) {
    const choix = dialog.showMessageBoxSync({
      type: "info",
      title: "Activation requise",
      message: "Cette installation n'est pas activee.",
      detail:
        `Empreinte de cette machine :\n${empreinte}\n\n` +
        "Transmettez ce code a votre fournisseur pour obtenir votre fichier " +
        "de licence (.geoaino), puis importez-le ci-dessous.",
      buttons: ["Importer une licence", "Quitter"],
      defaultId: 0,
      cancelId: 1,
    });

    if (choix === 1) {
      app.quit();
      return false;
    }

    const fichiers = dialog.showOpenDialogSync({
      title: "Selectionner le fichier de licence",
      filters: [{ name: "Licence GeoAino", extensions: ["geoaino"] }],
      properties: ["openFile"],
    });
    if (!fichiers || fichiers.length === 0) continue; // annule -> reboucle sur le message

    try {
      const candidate = JSON.parse(readFileSync(fichiers[0], "utf8")) as Licence;
      if (licenceEstValide(candidate)) {
        enregistrerLicence(candidate);
        licence = candidate;
        continue; // la boucle while re-teste licenceEstValide(licence) -> sort cette fois
      }
      dialog.showErrorBox(
        "Licence invalide",
        "Fichier de licence invalide ou ne correspondant pas a cette machine.",
      );
    } catch {
      dialog.showErrorBox(
        "Licence invalide",
        "Fichier de licence invalide ou ne correspondant pas a cette machine.",
      );
    }
  }
  return true;
}
```

- [ ] **Step 3: Brancher le gate au tout début de `demarrerApplication`**

Modifier :

```typescript
async function demarrerApplication(): Promise<void> {
  clusterPg = await demarrerPostgresPortable({
```

en :

```typescript
async function demarrerApplication(): Promise<void> {
  if (!assurerLicenceActivee()) return;

  clusterPg = await demarrerPostgresPortable({
```

- [ ] **Step 4: Vérification TypeScript**

Run: `npx tsc -p desktop/tsconfig.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 5: Vérification manuelle bout en bout**

Prérequis : Task 3 terminée (vraie clé publique branchée), build packagé
disponible (`npm run dist:desktop`) ou app lancée en dev via Electron
(`npx electron desktop/dist/main.js` après `npm run build:desktop` — voir
`docs/BUREAU-AUTONOME.md` pour le détail des commandes de build).

1. Si `%APPDATA%\GeoAino\licence.dat` existe déjà d'un test précédent, le
   renommer de côté (ne pas le supprimer).
2. Lancer l'app → vérifier qu'une boîte de dialogue « Activation requise »
   s'affiche avec une empreinte de la forme `XXXX-XXXX-...`, **avant** toute
   tentative de démarrage de Postgres (aucun process `postgres.exe` ne doit
   apparaître avant l'activation).
3. Cliquer **Quitter** → vérifier que l'app se ferme immédiatement, sans
   dialogue supplémentaire, sans process Postgres/Next lancé.
4. Relancer l'app, cliquer **Importer une licence**, sélectionner un fichier
   `.geoaino` invalide (JSON corrompu, ou copier-coller le fichier généré à
   l'étape 6 de Task 3 avec le mauvais `machineId`) → vérifier le message
   générique « Fichier de licence invalide ou ne correspondant pas à cette
   machine. » et le retour à la boîte « Activation requise ».
5. Générer une vraie licence pour l'empreinte affichée à l'étape 2 :
   `npx tsx desktop/scripts/licence/generer-licence.ts "<empreinte affichee>" "Test manuel"`
6. Relancer l'app, importer ce fichier → vérifier le démarrage normal
   (Postgres démarre, fenêtre s'ouvre).
7. Relancer l'app une seconde fois → vérifier l'absence de redemande
   d'activation (licence déjà enregistrée, revalidée silencieusement).

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main.ts
git commit -m "feat(desktop): verifier la cle d'activation avant tout demarrage"
```

---

### Task 5: Documentation (`docs/BUREAU-AUTONOME.md`)

**Files:**
- Modify: `docs/BUREAU-AUTONOME.md`

**Interfaces:** aucune — tâche documentaire uniquement.

- [ ] **Step 1: Ajouter une section « Clé d'activation » après la section « 1. Architecture en un coup d'œil »**

Insérer, après la fin du tableau des fichiers de la section 1 (juste avant
« Emplacement des données persistantes ») :

```markdown
### Clé d'activation (protection de licence)

Chaque installation doit être activée par une licence liée à la machine
avant de pouvoir démarrer Postgres/Next — voir
[`docs/superpowers/specs/2026-09-13-cle-activation-desktop-design.md`](./superpowers/specs/2026-09-13-cle-activation-desktop-design.md)
pour le design complet. En bref :

1. Au premier lancement (ou si `licence.dat` est absente/invalide), l'app
   affiche l'empreinte de la machine (dérivée du `MachineGuid` Windows,
   `desktop/src/machine-id.ts`) et bloque tout démarrage de Postgres/Next
   tant qu'aucune licence valide n'est importée.
2. Le client transmet cette empreinte au vendeur.
3. **Vendeur** (une seule fois par installation de l'outillage) :
   ```bash
   npx tsx desktop/scripts/licence/generer-cle-vendeur.ts   # une seule fois, jamais rejoue
   npx tsx desktop/scripts/licence/generer-licence.ts "<empreinte du client>" "<nom du client>"
   npx tsx desktop/scripts/licence/verifier-licence.ts licence-<nom>.geoaino
   ```
4. Le fichier `licence-<nom>.geoaino` produit est transmis au client (email,
   clé USB), qui l'importe via le bouton « Importer une licence ».
5. La licence est enregistrée dans `%APPDATA%\GeoAino\licence.dat` et
   revalidée (signature + empreinte) à chaque lancement suivant.

**Limitations assumées** (cf. spec pour le détail) :
- Perte/compromission de la clé privée vendeur (`cle-privee-vendeur.pem`,
  jamais committée) → toutes les licences déjà émises deviennent invalides
  après rotation de la clé, il faut republier l'app avec la nouvelle clé
  publique et réémettre une licence à chaque client existant.
- Réinstallation de Windows ou changement de disque sur le poste client →
  nouvelle empreinte machine → l'ancienne licence ne fonctionne plus, il
  faut en émettre une nouvelle.
- Aucune révocation à distance d'une licence déjà activée (cohérent avec le
  choix « 100% hors ligne, perpétuelle »).
```

- [ ] **Step 2: Ajouter les commandes de test au tableau de la section 4 (« Commandes de test »)**

Ajouter deux lignes au tableau existant :

```markdown
| `npx tsx desktop/scripts/test-machine-id.ts` | Format/déterminisme/unicité de l'empreinte machine — pur, sans toucher au registre Windows |
| `npx tsx desktop/scripts/test-licence.ts` | Vérification de signature Ed25519 (acceptation/rejet) — clé de test jetable, sans dépendre de la vraie clé vendeur |
```

- [ ] **Step 3: Ajouter la limitation à la section 7 (« Limitations connues »)**

Ajouter au tableau à puces existant :

```markdown
- **Licence liée à la machine, gestion manuelle par le vendeur** — pas
  d'auto-activation ni de portail client ; chaque licence est générée à la
  main par le vendeur via `desktop/scripts/licence/generer-licence.ts`
  (voir la section « Clé d'activation » ci-dessus).
```

- [ ] **Step 4: Renvoyer vers la nouvelle section depuis « 5. Vérification manuelle »**

Dans la section `## 5. Vérification manuelle (...)`, juste avant le point
numéroté `1. **Installer réellement**`, insérer :

```markdown
Avant toute chose : le premier lancement affichera la boîte d'activation
décrite ci-dessus (section « Clé d'activation ») — générer une licence de
test pour l'empreinte affichée (`generer-licence.ts`) avant de pouvoir
poursuivre les étapes ci-dessous.
```

- [ ] **Step 5: Commit**

```bash
git add docs/BUREAU-AUTONOME.md
git commit -m "docs(desktop): documenter la cle d'activation"
```
