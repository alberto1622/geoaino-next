"use server";

import { z } from "zod";
import { hash } from "bcryptjs";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guards";

/** Liste des comptes pour la page /admin/utilisateurs (ADMIN uniquement). */
export async function listUsers() {
  await requireAdmin();
  return prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      lastSignedIn: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1, "Nom requis").max(100),
  email: z.string().trim().email("Email invalide"),
  password: z.string().min(8, "Mot de passe de 8 caractères minimum").max(200),
  role: z.enum(["USER", "ADMIN"]),
});

export async function createUserAction(input: z.infer<typeof createSchema>) {
  await requireAdmin();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, error: parsed.error.issues[0]?.message ?? "Données invalides" };
  }
  const { name, email, password, role } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { success: false as const, error: "Cet email est déjà utilisé." };
  }

  const hashed = await hash(password, 12);
  await prisma.user.create({ data: { name, email, password: hashed, role } });
  revalidatePath("/admin/utilisateurs");
  return { success: true as const };
}

const roleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["USER", "ADMIN"]),
});

export async function setUserRoleAction(input: z.infer<typeof roleSchema>) {
  const adminId = await requireAdmin();
  const { userId, role } = roleSchema.parse(input);

  // Anti-verrouillage : on ne se rétrograde pas soi-même, et il doit toujours
  // rester au moins un ADMIN.
  if (role === "USER") {
    if (userId === adminId) {
      return { success: false as const, error: "Impossible de retirer votre propre rôle ADMIN." };
    }
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (target?.role === "ADMIN" && admins <= 1) {
      return { success: false as const, error: "Il doit rester au moins un administrateur." };
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });
  revalidatePath("/admin/utilisateurs");
  return { success: true as const };
}
