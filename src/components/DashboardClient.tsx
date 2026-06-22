"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BarChart2, AlertTriangle, CheckCircle, FileText,
  MapPin, TrendingUp, Database, Activity, Search, X, ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NavBar } from "@/components/NavBar";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, CartesianGrid,
} from "recharts";
import { toNum } from "@/lib/utils";

const ERROR_COLORS: Record<string, string> = {
  OVERLAP: "#ef4444", GAP: "#f59e0b", SLIVER: "#a855f7",
  DUPLICATE: "#3b82f6", INVALID_GEOM: "#ec4899",
  BOUNDARY_CROSS: "#06b6d4", MISSING_NICAD: "#22c55e", SELF_INTERSECT: "#f97316",
};

interface Analysis {
  id: number;
  fileName: string;
  fileFormat: string;
  status: string;
  conformityScore: number;
  errorCount: number | null;
  totalFeatures: number | null;
  commune: string | null;
  region: string | null;
  createdAt: string;
}

type Period = "TODAY" | "WEEK" | "MONTH" | "ALL";

const PERIOD_OPTIONS: { key: Period; label: string }[] = [
  { key: "ALL", label: "Tout" },
  { key: "TODAY", label: "Aujourd'hui" },
  { key: "WEEK", label: "7 jours" },
  { key: "MONTH", label: "30 jours" },
];

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  period: Period;
  selectedAnalysisId: number | null;
  allFiles: Array<{ id: number; fileName: string; createdAt: string }>;
  stats: {
    totalAnalyses: number;
    totalParcelles: number;
    totalErrors: number;
    avgConformity: number;
    errorsByType: Record<string, number>;
    recentAnalyses: Analysis[];
    trendData: Array<{ id: number; fileName: string; conformityScore: number; errorCount: number; createdAt: string }>;
  };
}

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: "Terminée",
  FAILED: "Échouée",
  PROCESSING: "En cours",
  PENDING: "En attente",
};

type StatusFilter = "ALL" | "COMPLETED" | "FAILED" | "PROCESSING";
type ConformityFilter = "ALL" | "GOOD" | "BAD";

export default function DashboardClient({ user, stats, period, selectedAnalysisId, allFiles }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [fileDropdownOpen, setFileDropdownOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [conformityFilter, setConformityFilter] = useState<ConformityFilter>("ALL");
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFileDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const buildUrl = (params: { period?: Period; analysisId?: number | null }) => {
    const p = params.period ?? period;
    const id = "analysisId" in params ? params.analysisId : selectedAnalysisId;
    const parts: string[] = [];
    if (p !== "ALL") parts.push(`period=${p}`);
    if (id) parts.push(`analysisId=${id}`);
    return `/dashboard${parts.length ? `?${parts.join("&")}` : ""}`;
  };

  const handlePeriodChange = (p: Period) => router.push(buildUrl({ period: p }));
  const handleFileSelect = (id: number | null) => {
    router.push(buildUrl({ analysisId: id }));
    setFileDropdownOpen(false);
    setFileSearch("");
  };

  const selectedFile = allFiles.find((f) => f.id === selectedAnalysisId);
  const filteredFiles = allFiles.filter((f) =>
    !fileSearch || f.fileName.toLowerCase().includes(fileSearch.toLowerCase())
  );

  const pieData = Object.entries(stats.errorsByType).map(([type, count]) => ({
    name: type,
    value: count,
    color: ERROR_COLORS[type] || "#6b7280",
  }));

  const filteredAnalyses = useMemo(() => {
    return stats.recentAnalyses.filter((a) => {
      if (search) {
        const q = search.toLowerCase();
        const match =
          a.fileName.toLowerCase().includes(q) ||
          (a.commune?.toLowerCase().includes(q) ?? false) ||
          (a.region?.toLowerCase().includes(q) ?? false);
        if (!match) return false;
      }
      if (statusFilter !== "ALL" && a.status !== statusFilter) return false;
      if (conformityFilter === "GOOD" && toNum(a.conformityScore) < 70) return false;
      if (conformityFilter === "BAD" && toNum(a.conformityScore) >= 70) return false;
      return true;
    });
  }, [stats.recentAnalyses, search, statusFilter, conformityFilter]);

  const hasActiveFilters = !!(search || statusFilter !== "ALL" || conformityFilter !== "ALL");

  const resetFilters = () => {
    setSearch("");
    setStatusFilter("ALL");
    setConformityFilter("ALL");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar user={user} />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BarChart2 className="w-6 h-6 text-primary" /> Tableau de bord
            </h1>
            <p className="text-muted-foreground text-sm mt-1">Vue d&apos;ensemble de toutes les analyses cadastrales</p>
          </div>
          <Link href="/" className="text-sm text-primary hover:underline flex items-center gap-1">
            <Activity className="w-4 h-4" /> Nouvelle analyse
          </Link>
        </div>

        {/* File + Period filters */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
          {/* File selector */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setFileDropdownOpen((v) => !v)}
              className={`flex items-center gap-2 h-8 px-3 rounded-lg border text-sm transition-all ${
                selectedAnalysisId
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="max-w-[200px] truncate">
                {selectedFile ? selectedFile.fileName : "Tous les fichiers"}
              </span>
              {selectedAnalysisId && (
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); handleFileSelect(null); }}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3" />
                </span>
              )}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${fileDropdownOpen ? "rotate-180" : ""}`} />
            </button>

            {fileDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 w-72 bg-card border border-border rounded-lg shadow-xl z-50">
                <div className="p-2 border-b border-border">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <input
                      autoFocus
                      value={fileSearch}
                      onChange={(e) => setFileSearch(e.target.value)}
                      placeholder="Rechercher un fichier..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-transparent border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto py-1">
                  <button
                    onClick={() => handleFileSelect(null)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 transition-colors ${!selectedAnalysisId ? "text-primary font-medium" : "text-foreground"}`}
                  >
                    Tous les fichiers
                  </button>
                  {filteredFiles.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => handleFileSelect(f.id)}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-secondary/50 transition-colors ${
                        selectedAnalysisId === f.id ? "text-primary font-medium bg-primary/5" : "text-foreground"
                      }`}
                    >
                      <p className="truncate">{f.fileName}</p>
                      <p className="text-muted-foreground text-[10px] mt-0.5">
                        {new Date(f.createdAt).toLocaleDateString("fr-FR")}
                      </p>
                    </button>
                  ))}
                  {filteredFiles.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-3">Aucun fichier trouvé</p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-border" />

          {/* Period pills */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Période :</span>
            {PERIOD_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => handlePeriodChange(key)}
                className={`text-xs px-3 py-1 rounded-full border transition-all ${
                  period === key
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Total Analyses", value: stats.totalAnalyses, icon: Database, color: "text-primary" },
            { label: "Parcelles Traitées", value: stats.totalParcelles.toLocaleString(), icon: MapPin, color: "text-blue-400" },
            { label: "Erreurs Détectées", value: stats.totalErrors.toLocaleString(), icon: AlertTriangle, color: "text-red-400" },
            { label: "Conformité Moyenne", value: `${toNum(stats.avgConformity).toFixed(1)}%`, icon: CheckCircle, color: "text-green-400" },
          ].map((kpi) => (
            <Card key={kpi.label}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm text-muted-foreground">{kpi.label}</p>
                  <kpi.icon className={`w-5 h-5 ${kpi.color}`} />
                </div>
                <p className={`text-3xl font-bold ${kpi.color}`}>{kpi.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" /> Évolution de la conformité
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={stats.trendData}>
                  <defs>
                    <linearGradient id="conformityGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="oklch(0.65 0.18 220)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="oklch(0.65 0.18 220)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.28 0 0)" />
                  <XAxis dataKey="fileName" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(0, 8)} stroke="oklch(0.60 0 0)" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="oklch(0.60 0 0)" />
                  <Tooltip
                    contentStyle={{ background: "oklch(0.175 0 0)", border: "1px solid oklch(0.28 0 0)", borderRadius: "8px" }}
                    formatter={(v) => [`${Number(v).toFixed(1)}%`, "Conformité"]}
                  />
                  <Area type="monotone" dataKey="conformityScore" stroke="oklch(0.65 0.18 220)" fill="url(#conformityGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-orange-400" /> Répartition des erreurs
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={70} dataKey="value">
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "oklch(0.175 0 0)", border: "1px solid oklch(0.28 0 0)", borderRadius: "8px" }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-1 mt-2">
                {pieData.slice(0, 4).map((item) => (
                  <div key={item.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: item.color }} />
                      <span className="text-muted-foreground">{item.name}</span>
                    </div>
                    <span className="font-mono">{item.value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {pieData.length > 0 && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="text-sm">Volume par type d&apos;erreur</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={pieData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.28 0 0)" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="oklch(0.60 0 0)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="oklch(0.60 0 0)" />
                  <Tooltip contentStyle={{ background: "oklch(0.175 0 0)", border: "1px solid oklch(0.28 0 0)", borderRadius: "8px" }} />
                  <Bar dataKey="value">
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Analyses with filters */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" /> Analyses
                <span className="text-muted-foreground font-normal">
                  ({filteredAnalyses.length}{filteredAnalyses.length !== stats.recentAnalyses.length ? ` / ${stats.recentAnalyses.length}` : ""})
                </span>
              </CardTitle>
              <Link href="/history" className="text-xs text-primary hover:underline">Historique complet</Link>
            </div>

            {/* Filters */}
            <div className="space-y-3 mt-4">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="Rechercher par nom, commune, région..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>

              {/* Filter pills row */}
              <div className="flex flex-wrap gap-4">
                {/* Status */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground shrink-0">Statut :</span>
                  {(["ALL", "COMPLETED", "FAILED", "PROCESSING"] as StatusFilter[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-all ${
                        statusFilter === s
                          ? "bg-primary/10 border-primary text-primary"
                          : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {s === "ALL" ? "Tous" : STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>

                {/* Conformity */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground shrink-0">Conformité :</span>
                  {([
                    { key: "ALL", label: "Toutes" },
                    { key: "GOOD", label: "≥ 70%" },
                    { key: "BAD", label: "< 70%" },
                  ] as { key: ConformityFilter; label: string }[]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setConformityFilter(key)}
                      className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-all ${
                        conformityFilter === key
                          ? "bg-primary/10 border-primary text-primary"
                          : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {hasActiveFilters && (
                  <button
                    onClick={resetFilters}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-auto"
                  >
                    <X className="w-3 h-3" /> Réinitialiser
                  </button>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="space-y-2">
              {filteredAnalyses.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Aucune analyse ne correspond aux filtres</p>
              ) : (
                filteredAnalyses.map((analysis) => (
                  <Link
                    key={analysis.id}
                    href={`/map/${analysis.id}`}
                    className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 hover:bg-secondary/20 transition-all group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-medium truncate">{analysis.fileName}</p>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary border border-border shrink-0">
                          {analysis.fileFormat}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{(analysis.totalFeatures ?? 0).toLocaleString()} parcelles</span>
                        <span>{analysis.errorCount ?? 0} erreurs</span>
                        {(analysis.commune || analysis.region) && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3 h-3" />
                            {[analysis.commune, analysis.region].filter(Boolean).join(", ")}
                          </span>
                        )}
                        <span>{new Date(analysis.createdAt).toLocaleDateString("fr-FR")}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      <span className={`text-sm font-bold ${toNum(analysis.conformityScore) >= 70 ? "text-green-400" : "text-orange-400"}`}>
                        {toNum(analysis.conformityScore).toFixed(0)}%
                      </span>
                      <Badge
                        variant={
                          analysis.status === "COMPLETED" ? "default"
                          : analysis.status === "FAILED" ? "destructive"
                          : "secondary"
                        }
                        className="text-[10px]"
                      >
                        {STATUS_LABELS[analysis.status] ?? analysis.status}
                      </Badge>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
