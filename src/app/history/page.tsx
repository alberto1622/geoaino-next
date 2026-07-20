import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import HistoryClient from "@/components/HistoryClient";

export const metadata = { title: "Historique des analyses" };

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string }>;
}) {
  const session = await auth();
  const { page = "1", search = "" } = await searchParams;
  const pageNum = Math.max(1, parseInt(page));
  const limit = 20;
  const offset = (pageNum - 1) * limit;

  const where = search
    ? {
        OR: [
          { fileName: { contains: search, mode: "insensitive" as const } },
          { commune: { contains: search, mode: "insensitive" as const } },
          { region: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    prisma.analysis.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true, fileName: true, fileFormat: true, fileSize: true,
        status: true, totalFeatures: true, errorCount: true,
        conformityScore: true, commune: true, region: true,
        createdAt: true, updatedAt: true,
        _count: { select: { topologicalErrors: true } },
      },
    }),
    prisma.analysis.count({ where }),
  ]);

  const analyses = rows.map((a) => ({
    ...a,
    fileSize: a.fileSize ? Number(a.fileSize) : null,
    conformityScore: Number(a.conformityScore),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }));

  return (
    <HistoryClient
      user={session?.user ?? null}
      analyses={analyses}
      total={total}
      page={pageNum}
      limit={limit}
      search={search}
    />
  );
}
