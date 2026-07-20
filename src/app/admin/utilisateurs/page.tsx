import { auth } from "@/lib/auth";
import { ShieldOff, Users } from "lucide-react";
import { listUsers } from "../_actions/users";
import { UsersAdminClient } from "@/components/admin/UsersAdminClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Gestion des utilisateurs" };

export default async function UtilisateursPage() {
  const session = await auth();
  const me = session?.user as { id?: string; role?: string } | undefined;

  if (me?.role !== "ADMIN") {
    return (
      <div className="mx-auto max-w-md py-16">
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <ShieldOff className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-bold tracking-tight">Accès réservé aux administrateurs</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Votre compte n&apos;a pas le rôle ADMIN. Si vous venez d&apos;être promu,
            déconnectez-vous puis reconnectez-vous pour que le rôle prenne effet.
          </p>
        </div>
      </div>
    );
  }

  const users = await listUsers();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Users className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Gestion des utilisateurs</h1>
          <p className="text-sm text-muted-foreground">
            Création des comptes et attribution du rôle ADMIN (opérations destructives et de masse).
          </p>
        </div>
      </div>

      <UsersAdminClient
        currentUserId={me.id ?? ""}
        users={users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          createdAt: u.createdAt.toISOString(),
          lastSignedIn: u.lastSignedIn.toISOString(),
        }))}
      />
    </div>
  );
}
