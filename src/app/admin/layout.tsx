import { auth } from "@/lib/auth";
import { NavBar } from "@/components/NavBar";

export const metadata = { title: "Administration" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <div className="min-h-screen flex flex-col">
      <NavBar user={session?.user ?? null} />
      <main className="mx-auto w-full max-w-5xl flex-1 p-6">{children}</main>
    </div>
  );
}
