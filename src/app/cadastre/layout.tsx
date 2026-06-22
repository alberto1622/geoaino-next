import { auth } from "@/lib/auth";
import { NavBar } from "@/components/NavBar";
import { CadastreSidebar } from "@/components/cadastre/CadastreSidebar";

export default async function CadastreLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <div className="min-h-screen flex flex-col">
      <NavBar user={session?.user ?? null} />
      <div className="flex flex-1">
        <CadastreSidebar />
        <main className="flex-1 min-w-0 p-6">{children}</main>
      </div>
    </div>
  );
}
