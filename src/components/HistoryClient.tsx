"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { History, Search, Trash2, MapPin, FileText, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { NavBar } from "@/components/NavBar";
import { toast } from "sonner";
import { toNum } from "@/lib/utils";

interface Analysis {
  id: number;
  fileName: string;
  fileFormat: string;
  fileSize: number | null;
  status: string;
  totalFeatures: number | null;
  errorCount: number | null;
  conformityScore: number;
  commune: string | null;
  region: string | null;
  createdAt: string;
}

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  analyses: Analysis[];
  total: number;
  page: number;
  limit: number;
  search: string;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HistoryClient({ user, analyses, total, page, limit, search }: Props) {
  const router = useRouter();
  const [searchValue, setSearchValue] = useState(search);
  const [deleting, setDeleting] = useState<number | null>(null);
  const totalPages = Math.ceil(total / limit);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(`/history?search=${encodeURIComponent(searchValue)}&page=1`);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Supprimer cette analyse ? Cette action est irréversible.")) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/analyses/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Erreur lors de la suppression");
      toast.success("Analyse supprimée");
      router.refresh();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeleting(null);
    }
  };

  const statusVariant = (status: string) => {
    switch (status) {
      case "COMPLETED": return "default";
      case "FAILED": return "destructive";
      case "PROCESSING": return "secondary";
      default: return "outline";
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar user={user} />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <History className="w-6 h-6 text-primary" /> Historique des analyses
            </h1>
            <p className="text-muted-foreground text-sm mt-1">{total} analyse{total > 1 ? "s" : ""} au total</p>
          </div>
          <Link href="/">
            <Button size="sm" className="gap-2">Nouvelle analyse</Button>
          </Link>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher par nom, commune, région..."
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">Rechercher</Button>
          {search && (
            <Button variant="ghost" onClick={() => { setSearchValue(""); router.push("/history"); }}>
              Effacer
            </Button>
          )}
        </form>

        {/* List */}
        <div className="space-y-3">
          {analyses.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <History className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                <p className="text-muted-foreground">Aucune analyse trouvée</p>
                <Link href="/">
                  <Button size="sm" className="mt-4">Créer une analyse</Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            analyses.map((analysis) => (
              <div
                key={analysis.id}
                className="flex items-center gap-4 p-4 rounded-xl border border-border bg-card hover:border-primary/30 transition-all group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                    <p className="text-sm font-medium truncate">{analysis.fileName}</p>
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-secondary border border-border shrink-0">
                      {analysis.fileFormat}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {(analysis.commune || analysis.region) && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {[analysis.commune, analysis.region].filter(Boolean).join(", ")}
                      </span>
                    )}
                    <span>{(analysis.totalFeatures ?? 0).toLocaleString()} parcelles</span>
                    <span>{analysis.errorCount ?? 0} erreurs</span>
                    <span>{formatBytes(analysis.fileSize)}</span>
                    <span>{new Date(analysis.createdAt).toLocaleDateString("fr-FR")}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className={`text-sm font-bold ${toNum(analysis.conformityScore) >= 70 ? "text-green-400" : "text-orange-400"}`}>
                    {toNum(analysis.conformityScore).toFixed(0)}%
                  </span>
                  <Badge variant={statusVariant(analysis.status) as "default" | "destructive" | "secondary" | "outline"} className="text-[10px]">
                    {analysis.status}
                  </Badge>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Link href={`/map/${analysis.id}`}>
                      <Button size="icon" variant="ghost" className="h-8 w-8">
                        <MapPin className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(analysis.id)}
                      disabled={deleting === analysis.id}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-8">
            <Link href={`/history?search=${search}&page=${page - 1}`}>
              <Button variant="outline" size="sm" disabled={page <= 1}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
            </Link>
            <span className="text-sm text-muted-foreground">
              Page {page} / {totalPages}
            </span>
            <Link href={`/history?search=${search}&page=${page + 1}`}>
              <Button variant="outline" size="sm" disabled={page >= totalPages}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
