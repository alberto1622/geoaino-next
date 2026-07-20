"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileText, Download, Eye, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NavBar } from "@/components/NavBar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { toNum } from "@/lib/utils";
import { exportReportPDF } from "@/lib/exportPdf";

interface Report {
  id: number;
  analysisId: number;
  reportType: string;
  title: string | null;
  content: string | null;
  createdAt: string;
  analysis: { fileName: string; conformityScore: number; totalFeatures: number | null } | null;
}

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  reports: Report[];
}

export default function ReportsClient({ user, reports }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Report | null>(reports[0] ?? null);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<Report | null>(null);

  const reportTypeLabel = (type: string) => {
    switch (type) {
      case "EXPERT": return "Expert";
      case "DETAILED": return "Détaillé";
      case "CORRECTION": return "Correction";
      default: return "Résumé";
    }
  };

  const handleDownload = () => {
    if (!selected?.content) return;
    const blob = new Blob([selected.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selected.title ?? "rapport"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadPDF = async () => {
    if (!selected) return;
    setGeneratingPdf(true);
    try {
      await exportReportPDF(selected);
    } finally {
      setGeneratingPdf(false);
    }
  };

  const performDeleteReport = async (reportId: number) => {
    setDeleting(reportId);
    try {
      const res = await fetch(`/api/reports/${reportId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Erreur lors de la suppression");
      toast.success("Rapport supprimé");
      if (selected?.id === reportId) {
        setSelected(reports.find((r) => r.id !== reportId) ?? null);
      }
      router.refresh();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeleting(null);
    }
  };

  const handleDeleteReport = (e: React.MouseEvent, report: Report) => {
    e.stopPropagation();
    setToDelete(report);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar user={user} />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" /> Rapports d&apos;expertise
          </h1>
          <p className="text-sm text-muted-foreground">{reports.length} rapport{reports.length > 1 ? "s" : ""}</p>
        </div>

        {reports.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-50" />
              <p className="text-muted-foreground mb-4">Aucun rapport généré</p>
              <Link href="/history">
                <Button size="sm">Voir les analyses</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-12rem)]">
            {/* Left: report list */}
            <div className="lg:col-span-1">
              <ScrollArea className="h-full pr-2">
                <div className="space-y-2">
                  {reports.map((report) => (
                    <button
                      key={report.id}
                      onClick={() => setSelected(report)}
                      className={`cursor-pointer w-full text-left p-4 rounded-xl border transition-all ${
                        selected?.id === report.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/30 hover:bg-secondary/20"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <Badge variant="default" className="text-[10px]">{reportTypeLabel(report.reportType)}</Badge>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => handleDeleteReport(e, report)}
                            disabled={deleting === report.id}
                            className="p-1 rounded cursor-pointer hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            title="Supprimer le rapport"
                            aria-label="Supprimer le rapport"
                          >
                            {deleting === report.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                        </div>
                      </div>
                      <p className="text-sm font-medium truncate mt-2">{report.title || "Rapport sans titre"}</p>
                      {report.analysis && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">{report.analysis.fileName}</p>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        {report.analysis && (
                          <span className={toNum(report.analysis.conformityScore) >= 70 ? "text-green-400" : "text-orange-400"}>
                            {toNum(report.analysis.conformityScore).toFixed(0)}%
                          </span>
                        )}
                        <span>{new Date(report.createdAt).toLocaleDateString("fr-FR")}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* Right: report content */}
            <div className="lg:col-span-2">
              {selected ? (
                <Card className="h-full flex flex-col">
                  <CardHeader className="flex-row items-center justify-between pb-3">
                    <CardTitle className="text-sm truncate flex-1">{selected.title}</CardTitle>
                    <div className="flex gap-2 shrink-0">
                      <Link href={`/map/${selected.analysisId}`}>
                        <Button size="sm" variant="outline" className="gap-1.5 h-8">
                          <Eye className="w-3.5 h-3.5" /> Carte
                        </Button>
                      </Link>
                      <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={handleDownload}>
                        <Download className="w-3.5 h-3.5" /> MD
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={handleDownloadPDF} disabled={generatingPdf}>
                        {generatingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} PDF
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-8 text-destructive hover:text-destructive"
                        onClick={(e) => handleDeleteReport(e, selected)}
                        disabled={deleting === selected.id}
                        aria-label="Supprimer le rapport"
                      >
                        {deleting === selected.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-hidden p-0">
                    <ScrollArea className="h-full px-6 pb-6">
                      <div className="prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown>{selected.content || "Contenu non disponible"}</ReactMarkdown>
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              ) : (
                <Card className="h-full flex items-center justify-center">
                  <p className="text-muted-foreground">Sélectionnez un rapport</p>
                </Card>
              )}
            </div>
          </div>
        )}
      </main>

      <ConfirmDialog
        open={toDelete !== null}
        title="Supprimer le rapport"
        description={`Supprimer le rapport « ${toDelete?.title ?? "sans titre"} » ?\nCette action est irréversible.`}
        confirmLabel="Supprimer"
        onConfirm={() => {
          if (toDelete) void performDeleteReport(toDelete.id);
          setToDelete(null);
        }}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
