"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AlertTriangle, Layers, ArrowLeft, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NavBar } from "@/components/NavBar";
import { errorTypeColor, toNum } from "@/lib/utils";

const MapLibreMap = dynamic(() => import("@/components/MapLibreMap"), { ssr: false });

interface GeoError {
  id: number;
  errorType: string;
  severity: string;
  nicad1?: string | null;
  nicad2?: string | null;
  description?: string | null;
  geometry?: unknown;
  area?: number | null;
  confidence: number;
  corrected: boolean;
}

interface Props {
  user: { name?: string | null; email?: string | null } | null;
  analysis: {
    id: number;
    fileName: string;
    totalFeatures: number | null;
    errorCount: number | null;
    conformityScore: number;
    geoJsonData: string | null;
    errors: GeoError[];
  };
}

const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "Critique", HIGH: "Élevé", MEDIUM: "Moyen", LOW: "Faible",
};

export default function TopologyClient({ user, analysis }: Props) {
  const [selectedError, setSelectedError] = useState<GeoError | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  const errorTypes = Array.from(new Set(analysis.errors.map((e) => e.errorType)));

  const toggleType = (type: string) => {
    const next = new Set(hiddenTypes);
    if (next.has(type)) next.delete(type); else next.add(type);
    setHiddenTypes(next);
  };

  const visibleErrors = analysis.errors.filter((e) => !hiddenTypes.has(e.errorType));

  const countBySeverity = (sev: string) => analysis.errors.filter((e) => e.severity === sev).length;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      <NavBar user={user} />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-80 border-r border-border flex flex-col bg-card shrink-0">
          <div className="p-4 border-b border-border">
            <Link href={`/map/${analysis.id}`}>
              <Button variant="ghost" size="sm" className="gap-1.5 mb-3 -ml-1">
                <ArrowLeft className="w-3.5 h-3.5" /> Retour analyse
              </Button>
            </Link>
            <h2 className="text-sm font-bold flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" /> Visionneuse Topologique
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{analysis.fileName}</p>

            {/* Score */}
            <div className="grid grid-cols-3 gap-2 mt-3">
              <div className="text-center p-2 rounded-lg bg-secondary border border-border">
                <p className="text-[10px] text-muted-foreground">Parcelles</p>
                <p className="text-sm font-bold">{(analysis.totalFeatures ?? 0).toLocaleString()}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-secondary border border-border">
                <p className="text-[10px] text-muted-foreground">Erreurs</p>
                <p className="text-sm font-bold text-red-400">{analysis.errorCount ?? 0}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-secondary border border-border">
                <p className="text-[10px] text-muted-foreground">Conformité</p>
                <p className={`text-sm font-bold ${toNum(analysis.conformityScore) >= 70 ? "text-green-400" : "text-orange-400"}`}>
                  {toNum(analysis.conformityScore).toFixed(0)}%
                </p>
              </div>
            </div>

            {/* Severity summary */}
            <div className="flex gap-1 mt-3">
              {[["CRITICAL", "text-red-400", "C"], ["HIGH", "text-orange-400", "E"], ["MEDIUM", "text-yellow-400", "M"], ["LOW", "text-blue-400", "F"]].map(([sev, color, letter]) => (
                <div key={sev} className="flex-1 text-center p-1.5 rounded-lg bg-secondary border border-border">
                  <p className={`text-xs font-bold ${color}`}>{countBySeverity(sev)}</p>
                  <p className="text-[9px] text-muted-foreground">{letter}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Layer toggles */}
          <div className="p-4 border-b border-border">
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <Filter className="w-3 h-3" /> Couches d&apos;erreurs
            </p>
            <div className="space-y-1.5">
              {errorTypes.map((type) => {
                const count = analysis.errors.filter((e) => e.errorType === type).length;
                const hidden = hiddenTypes.has(type);
                return (
                  <button
                    key={type}
                    onClick={() => toggleType(type)}
                    className={`w-full flex items-center gap-2 p-2 rounded-lg text-xs transition-all border ${
                      hidden ? "border-border opacity-50" : "border-primary/30 bg-primary/5"
                    }`}
                  >
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: hidden ? "#6b7280" : errorTypeColor(type) }} />
                    <span className="flex-1 text-left">{type}</span>
                    <span className="text-muted-foreground font-mono">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Error list */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-1.5">
              {visibleErrors.map((err) => (
                <button
                  key={err.id}
                  onClick={() => setSelectedError(selectedError?.id === err.id ? null : err)}
                  className={`w-full text-left p-2.5 rounded-lg border transition-all text-xs ${
                    selectedError?.id === err.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"
                  } ${err.corrected ? "opacity-40" : ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: errorTypeColor(err.errorType) }} />
                    <span className="font-mono">{err.errorType}</span>
                    <Badge
                      variant={err.severity.toLowerCase() as "critical" | "high" | "medium" | "low"}
                      className="text-[8px] h-3.5 px-1 ml-auto"
                    >
                      {SEVERITY_LABELS[err.severity]?.charAt(0)}
                    </Badge>
                  </div>
                  {err.nicad1 && <p className="text-muted-foreground truncate mt-1">{err.nicad1}</p>}
                  {err.area && <p className="text-muted-foreground">{err.area.toFixed(1)} m²</p>}
                </button>
              ))}
            </div>
          </ScrollArea>

          {/* Selected error detail */}
          {selectedError && (
            <div className="p-4 border-t border-border bg-card/50">
              <p className="text-xs font-semibold mb-2 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-400" /> Détails
              </p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p><strong className="text-foreground">Type:</strong> {selectedError.errorType}</p>
                <p><strong className="text-foreground">Sévérité:</strong> {SEVERITY_LABELS[selectedError.severity]}</p>
                {selectedError.nicad1 && <p><strong className="text-foreground">NICAD:</strong> {selectedError.nicad1}</p>}
                {selectedError.area && <p><strong className="text-foreground">Surface:</strong> {selectedError.area.toFixed(2)} m²</p>}
                <p><strong className="text-foreground">Confiance:</strong> {(selectedError.confidence * 100).toFixed(0)}%</p>
                {selectedError.description && <p className="mt-1">{selectedError.description}</p>}
              </div>
            </div>
          )}
        </div>

        {/* Map */}
        <div className="flex-1 relative">
          <MapLibreMap
            geoJson={analysis.geoJsonData}
            errors={visibleErrors}
            selectedErrorId={selectedError?.id}
          />
        </div>
      </div>
    </div>
  );
}
