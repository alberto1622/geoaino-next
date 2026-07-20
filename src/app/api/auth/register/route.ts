import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hash } from "bcryptjs";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["USER", "ADMIN"]).default("USER"),
});

/**
 * POST /api/auth/register — création de compte réservée aux administrateurs
 * (pas d'inscription publique : la plateforme manipule le référentiel cadastral).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentification requise" }, { status: 401 });
  }
  const role = (session.user as { role?: string }).role;
  if (role !== "ADMIN") {
    return NextResponse.json(
      { error: "Création de compte réservée aux administrateurs" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Données invalides : email requis, mot de passe de 8 caractères minimum" },
      { status: 400 },
    );
  }
  const { name, email, password, role: newRole } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Cet email est déjà utilisé" }, { status: 409 });
  }

  const hashed = await hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, password: hashed, role: newRole },
  });

  return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role });
}
