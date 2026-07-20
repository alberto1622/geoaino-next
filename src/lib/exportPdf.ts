/**
 * exportPdf.ts — Export PDF des rapports d'expertise
 * GEO-AINO SUPREME™  (design identique au projet geoaino_supreme_web)
 */

import type { jsPDF as JsPDFType } from "jspdf";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PdfReport {
  id: number;
  analysisId: number;
  reportType: string;
  title: string | null;
  content: string | null;
  createdAt: string;
  analysis: {
    fileName: string;
    conformityScore: number;
    totalFeatures: number | null;
  } | null;
}

// ─── Utilitaires ───────────────────────────────────────────────────────────────

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
}

function scoreColor(score: number): [number, number, number] {
  if (score >= 90) return [34, 197, 94];
  if (score >= 70) return [234, 179, 8];
  if (score >= 50) return [249, 115, 22];
  return [239, 68, 68];
}

function reportTypeLabel(type: string): string {
  switch (type) {
    case "EXPERT":     return "Expert";
    case "DETAILED":   return "Détaillé";
    case "CORRECTION": return "Correction";
    default:           return "Résumé";
  }
}

function splitText(doc: JsPDFType, text: string, maxWidth: number): string[] {
  return doc.splitTextToSize(text, maxWidth) as string[];
}

// ─── Tableaux Markdown ──────────────────────────────────────────────────────────

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return /^[\s:|-]+$/.test(inner) && inner.includes("-");
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderMarkdownTable(
  doc: JsPDFType,
  headers: string[],
  rows: string[][],
  x: number,
  yStart: number,
  totalWidth: number,
  pageH: number,
  margin: number
): number {
  let y = yStart;
  const fontSize = 7;
  const lineHeight = 3.6;
  const cellPad = 1.5;
  const minColW = totalWidth * 0.12;

  const colCount = headers.length;
  const maxLens = headers.map((h, ci) => {
    let max = h.length;
    rows.forEach((r) => { max = Math.max(max, (r[ci] || "").length); });
    return Math.max(max, 3);
  });
  const totalLen = maxLens.reduce((a, b) => a + b, 0);
  const rawWidths = maxLens.map((l) => Math.max((l / totalLen) * totalWidth, minColW));
  const widthSum = rawWidths.reduce((a, b) => a + b, 0);
  const colWidths = rawWidths.map((w) => (w * totalWidth) / widthSum);

  doc.setFontSize(fontSize);

  function getLines(text: string, w: number): string[] {
    return splitText(doc, text, Math.max(w - cellPad * 2, 5));
  }

  function drawRow(cells: string[], isHeader: boolean, isAlt: boolean) {
    const linesPerCell = cells.map((c, ci) => getLines(c, colWidths[ci] ?? colWidths[colWidths.length - 1]));
    const maxLines = Math.max(1, ...linesPerCell.map((l) => l.length));
    const rowH = maxLines * lineHeight + cellPad * 2;

    if (y + rowH > pageH - 14) {
      doc.addPage();
      y = margin;
    }

    doc.setDrawColor(226, 232, 240);
    if (isHeader) {
      doc.setFillColor(14, 165, 233);
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
    } else {
      doc.setFillColor(isAlt ? 248 : 255, isAlt ? 250 : 255, isAlt ? 252 : 255);
      doc.setTextColor(51, 65, 85);
      doc.setFont("helvetica", "normal");
    }
    doc.rect(x, y, totalWidth, rowH, "F");

    let cx = x;
    for (let ci = 0; ci < colCount; ci++) {
      const w = colWidths[ci] ?? colWidths[colWidths.length - 1];
      doc.rect(cx, y, w, rowH, "S");
      doc.text(linesPerCell[ci] ?? [""], cx + cellPad, y + cellPad + lineHeight * 0.75);
      cx += w;
    }

    y += rowH;
  }

  drawRow(headers, true, false);
  rows.forEach((r, idx) => drawRow(r, false, idx % 2 === 1));

  return y;
}

// ─── Export principal ──────────────────────────────────────────────────────────

export async function exportReportPDF(report: PdfReport): Promise<void> {
  const { jsPDF } = await import("jspdf");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const PAGE_W   = 210;
  const PAGE_H   = 297;
  const MARGIN   = 14;
  const CONTENT_W = PAGE_W - 2 * MARGIN;
  let y = MARGIN;

  const score = toNum(report.analysis?.conformityScore);
  const [sr, sg, sb] = scoreColor(score);

  // ── En-tête — bande bleue ──────────────────────────────────────────────────
  doc.setFillColor(14, 165, 233); // sky-500
  doc.rect(0, 0, PAGE_W, 22, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("GéoAino", MARGIN, 10);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text("Fiabilisation des données cadastrales", MARGIN, 16);

  doc.setFontSize(8);
  doc.text(
    `Généré le ${new Date().toLocaleDateString("fr-FR", {
      day: "2-digit", month: "long", year: "numeric",
    })} · Analyse #${report.analysisId}`,
    PAGE_W - MARGIN, 10, { align: "right" }
  );
  if (report.analysis) {
    doc.text(`Fichier : ${report.analysis.fileName}`, PAGE_W - MARGIN, 16, { align: "right" });
  }

  y = 30;

  // ── KPI Cards ─────────────────────────────────────────────────────────────
  type RGB = [number, number, number];
  const kpis: Array<{ label: string; value: string; color: RGB }> = [
    {
      label: "Parcelles",
      value: (report.analysis?.totalFeatures ?? 0).toLocaleString("fr-FR"),
      color: [59, 130, 246],
    },
    {
      label: "Conformité",
      value: `${score.toFixed(1)}%`,
      color: [sr, sg, sb],
    },
    {
      label: "Type",
      value: reportTypeLabel(report.reportType),
      color: [99, 102, 241],
    },
    {
      label: "Date",
      value: new Date(report.createdAt).toLocaleDateString("fr-FR"),
      color: [71, 85, 105],
    },
  ];

  const cardW = (CONTENT_W - 6) / 4;
  kpis.forEach((kpi, i) => {
    const x = MARGIN + i * (cardW + 2);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, y, cardW, 18, 2, 2, "FD");

    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text(kpi.label.toUpperCase(), x + cardW / 2, y + 5.5, { align: "center" });

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(kpi.color[0], kpi.color[1], kpi.color[2]);
    doc.text(kpi.value, x + cardW / 2, y + 13, { align: "center" });
  });

  y += 24;

  // ── Barre de conformité ────────────────────────────────────────────────────
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("Score de conformité topologique", MARGIN, y);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(sr, sg, sb);
  doc.text(`${score.toFixed(1)}%`, PAGE_W - MARGIN, y, { align: "right" });
  y += 4;

  doc.setFillColor(226, 232, 240);
  doc.roundedRect(MARGIN, y, CONTENT_W, 4, 2, 2, "F");
  const barW = (score / 100) * CONTENT_W;
  if (barW > 0) {
    doc.setFillColor(sr, sg, sb);
    doc.roundedRect(MARGIN, y, barW, 4, 2, 2, "F");
  }
  y += 12;

  // ── Titre du rapport ──────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  const titleLines = splitText(doc, report.title || "Rapport sans titre", CONTENT_W);
  doc.text(titleLines, MARGIN, y);
  y += titleLines.length * 5.5 + 3;

  doc.setDrawColor(226, 232, 240);
  doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
  y += 6;

  // ── Contenu IA ────────────────────────────────────────────────────────────
  if (report.content) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(15, 23, 42);
    doc.text("🤖  Rapport d'expertise IA", MARGIN, y);
    y += 6;

    const cleanText = report.content
      .replace(/^#{1,3} (.+)$/gm, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/^_(.+)_$/gm, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/^[-*+] (.+)$/gm, "• $1")
      .replace(/^\d+\. (.+)$/gm, "  $1")
      .replace(/\n{3,}/g, "\n\n");

    const lines = cleanText.split("\n");
    let li = 0;

    while (li < lines.length) {
      const line = lines[li];

      // ── Tableau Markdown ─────────────────────────────────────────────────
      if (isTableRow(line) && li + 1 < lines.length && isTableSeparator(lines[li + 1])) {
        const headers = parseTableRow(line);
        li += 2;
        const rows: string[][] = [];
        while (li < lines.length && isTableRow(lines[li])) {
          rows.push(parseTableRow(lines[li]));
          li++;
        }
        if (y > PAGE_H - 30) { doc.addPage(); y = MARGIN; }
        y = renderMarkdownTable(doc, headers, rows, MARGIN, y, CONTENT_W, PAGE_H, MARGIN);
        y += 4;
        continue;
      }

      // ── Ligne vide : séparateur de paragraphe ────────────────────────────
      if (line.trim() === "") { li++; continue; }

      // ── Accumulation d'un paragraphe ─────────────────────────────────────
      const paraLines = [line];
      li++;
      while (
        li < lines.length &&
        lines[li].trim() !== "" &&
        !(isTableRow(lines[li]) && li + 1 < lines.length && isTableSeparator(lines[li + 1]))
      ) {
        paraLines.push(lines[li]);
        li++;
      }

      if (y > PAGE_H - 20) { doc.addPage(); y = MARGIN; }

      const trimmed = paraLines.join(" ").trim();

      // Détecter les titres de section (anciens ## xxx nettoyés → ligne courte sans •)
      const isSectionTitle =
        trimmed.length < 60 &&
        !trimmed.startsWith("•") &&
        !trimmed.includes(" ") === false &&
        trimmed === trimmed.replace(/[^a-zA-ZÀ-ÿ0-9 :.,\-–—]/g, "").trim() &&
        /^[A-ZÀ-Ÿ0-9]/.test(trimmed);

      if (isSectionTitle) {
        doc.setFontSize(8.5);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(14, 165, 233);
        const titleLines = splitText(doc, trimmed, CONTENT_W);
        doc.text(titleLines, MARGIN, y);
        y += titleLines.length * 4.5 + 2;
      } else {
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(51, 65, 85);
        const bodyLines = splitText(doc, trimmed, CONTENT_W);
        doc.text(bodyLines, MARGIN, y);
        y += bodyLines.length * 4 + 3;
      }
    }
  }

  // ── Pied de page (toutes les pages) ───────────────────────────────────────
  const totalPages = (
    doc as unknown as { internal: { getNumberOfPages: () => number } }
  ).internal.getNumberOfPages();

  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(248, 250, 252);
    doc.rect(0, PAGE_H - 10, PAGE_W, 10, "F");
    doc.setDrawColor(226, 232, 240);
    doc.line(0, PAGE_H - 10, PAGE_W, PAGE_H - 10);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(148, 163, 184);
    doc.text(
      "GéoAino — Rapport d'analyse cadastrale",
      MARGIN, PAGE_H - 4
    );
    doc.text(`Page ${p} / ${totalPages}`, PAGE_W - MARGIN, PAGE_H - 4, { align: "right" });
  }

  // ── Sauvegarde ────────────────────────────────────────────────────────────
  const safeName = (report.analysis?.fileName || "rapport")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  doc.save(`GEO-AINO_Rapport_${safeName}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
