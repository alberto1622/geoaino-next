/**
 * Gestion du rôle administrateur (RBAC) : liste les comptes ou promeut un
 * compte en ADMIN. Les opérations destructives (suppression de lots de
 * sections, migration en masse, basculement batch) exigent ce rôle.
 *
 * Usage :
 *   npx tsx scripts/set-admin.ts                     → liste les comptes (email, rôle)
 *   npx tsx scripts/set-admin.ts email@exemple.sn    → promeut ce compte en ADMIN
 */
import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";

// Charge DATABASE_URL depuis .env.local / .env (Next les charge, pas Node).
for (const file of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];

  if (!email) {
    const users = await prisma.user.findMany({
      select: { email: true, name: true, role: true, lastSignedIn: true },
      orderBy: { createdAt: "asc" },
    });
    if (!users.length) {
      console.log("Aucun compte en base.");
      return;
    }
    console.log("Comptes existants :");
    for (const u of users) {
      console.log(
        `  ${u.role.padEnd(5)}  ${u.email ?? "(sans email)"}  ${u.name ?? ""}  (dernière connexion : ${u.lastSignedIn.toISOString().slice(0, 10)})`,
      );
    }
    console.log("\nPour promouvoir : npx tsx scripts/set-admin.ts <email>");
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Aucun compte avec l'email ${email}.`);
    process.exitCode = 1;
    return;
  }
  if (user.role === "ADMIN") {
    console.log(`${email} est déjà ADMIN.`);
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  console.log(`${email} promu ADMIN.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
