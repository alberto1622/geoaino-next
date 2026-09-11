import { createServer } from "node:net";

/** Teste si un port TCP local est libre en tentant d'y écouter brièvement. */
export function portLibre(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const serveur = createServer();
    serveur.once("error", () => resolve(false));
    serveur.once("listening", () => serveur.close(() => resolve(true)));
    serveur.listen(port, "127.0.0.1");
  });
}

export async function trouverPortLibre(candidats: number[]): Promise<number> {
  for (const port of candidats) {
    if (await portLibre(port)) return port;
  }
  throw new Error(
    `Aucun port libre parmi ${candidats.join(", ")} — un autre processus local occupe toute la plage.`,
  );
}
