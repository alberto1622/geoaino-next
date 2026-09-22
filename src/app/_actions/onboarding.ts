"use server";

import { requireUserId } from "@/lib/auth-guards";
import { prisma } from "@/lib/prisma";

export async function getOnboardingStatus(): Promise<{ vu: boolean }> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboardingVuLe: true },
  });
  return { vu: !!user?.onboardingVuLe };
}

export async function marquerOnboardingVu(): Promise<void> {
  const userId = await requireUserId();
  // Idempotent : n'écrase jamais une date déjà posée (ne réinitialise pas
  // le tour à une reconnexion suivante si déjà marqué vu).
  await prisma.user.updateMany({
    where: { id: userId, onboardingVuLe: null },
    data: { onboardingVuLe: new Date() },
  });
}
