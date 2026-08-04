import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import MapEmptyClient from "@/components/MapEmptyClient";

export const metadata = { title: "Carte" };

export default async function MapPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <MapEmptyClient user={session.user} />;
}
