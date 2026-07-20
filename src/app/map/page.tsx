import { auth } from "@/lib/auth";
import MapEmptyClient from "@/components/MapEmptyClient";

export const metadata = { title: "Carte" };

export default async function MapPage() {
  const session = await auth();
  return <MapEmptyClient user={session?.user ?? null} />;
}
