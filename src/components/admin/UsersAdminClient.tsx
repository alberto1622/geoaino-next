"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { UserPlus, ShieldCheck, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createUserAction, setUserRoleAction } from "@/app/admin/_actions/users";

interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  createdAt: string;
  lastSignedIn: string;
}

const selectCls =
  "h-9 rounded-lg border border-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RoleBadge({ role }: { role: string }) {
  return role === "ADMIN" ? (
    <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      <ShieldCheck className="h-3 w-3" /> ADMIN
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
      <Shield className="h-3 w-3" /> USER
    </span>
  );
}

export function UsersAdminClient({
  users,
  currentUserId,
}: {
  users: UserRow[];
  currentUserId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"USER" | "ADMIN">("USER");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const res = await createUserAction({ name, email, password, role });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(`Compte ${email} créé (${role}).`);
        setName("");
        setEmail("");
        setPassword("");
        setRole("USER");
      } catch {
        toast.error("Échec de la création du compte.");
      }
    });
  }

  function handleRoleChange(user: UserRow, newRole: "USER" | "ADMIN") {
    if (newRole === user.role) return;
    startTransition(async () => {
      try {
        const res = await setUserRoleAction({ userId: user.id, role: newRole });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(
          `${user.email} : rôle ${newRole}. Le changement prend effet à sa prochaine connexion.`,
        );
      } catch {
        toast.error("Échec du changement de rôle.");
      }
    });
  }

  const dateFmt = (iso: string) => new Date(iso).toLocaleDateString("fr-FR");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-primary" /> Créer un compte
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Input
              placeholder="Nom"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="off"
            />
            <Input
              type="email"
              placeholder="email@exemple.sn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="off"
            />
            <Input
              type="password"
              placeholder="Mot de passe (8 car. min.)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
            <select
              className={selectCls}
              value={role}
              onChange={(e) => setRole(e.target.value as "USER" | "ADMIN")}
              aria-label="Rôle du nouveau compte"
            >
              <option value="USER">USER</option>
              <option value="ADMIN">ADMIN</option>
            </select>
            <Button type="submit" disabled={pending} className="gap-2">
              <UserPlus className="h-4 w-4" />
              {pending ? "Création…" : "Créer"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comptes ({users.length})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Nom</th>
                <th className="py-2 pr-4 font-medium">Email</th>
                <th className="py-2 pr-4 font-medium">Rôle</th>
                <th className="py-2 pr-4 font-medium">Créé le</th>
                <th className="py-2 pr-4 font-medium">Dernière connexion</th>
                <th className="py-2 font-medium">Changer le rôle</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border/50">
                  <td className="py-2.5 pr-4">
                    {u.name ?? "—"}
                    {u.id === currentUserId ? (
                      <span className="ml-2 text-xs text-muted-foreground">(vous)</span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs">{u.email ?? "—"}</td>
                  <td className="py-2.5 pr-4">
                    <RoleBadge role={u.role} />
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{dateFmt(u.createdAt)}</td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{dateFmt(u.lastSignedIn)}</td>
                  <td className="py-2.5">
                    <select
                      className={selectCls}
                      value={u.role}
                      disabled={pending || u.id === currentUserId}
                      onChange={(e) => handleRoleChange(u, e.target.value as "USER" | "ADMIN")}
                      aria-label={`Rôle de ${u.email}`}
                      title={
                        u.id === currentUserId
                          ? "Vous ne pouvez pas modifier votre propre rôle"
                          : undefined
                      }
                    >
                      <option value="USER">USER</option>
                      <option value="ADMIN">ADMIN</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-xs text-muted-foreground">
            Le rôle est embarqué dans le jeton de session : un changement prend effet à la
            prochaine connexion de l&apos;utilisateur concerné.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
