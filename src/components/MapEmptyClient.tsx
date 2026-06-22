"use client";
import dynamic from "next/dynamic";
import { NavBar } from "@/components/NavBar";
import { MapPin } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const LeafletMap = dynamic(() => import("@/components/LeafletMap"), { ssr: false });

interface Props {
  user: { name?: string | null; email?: string | null } | null;
}

export default function MapEmptyClient({ user }: Props) {
  return (
    <div className="h-screen flex flex-col bg-background">
      <NavBar user={user} />
      <div className="flex-1 relative">
        <LeafletMap geoJson={null} errors={[]} />
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
          <div className="flex items-center gap-3 px-5 py-3 rounded-xl border border-border bg-card/90 backdrop-blur-sm shadow-xl">
            <MapPin className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">Aucune analyse chargée</span>
            <Link href="/">
              <Button size="sm" className="gap-1.5">Charger un fichier</Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
