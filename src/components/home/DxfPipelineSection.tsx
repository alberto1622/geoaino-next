"use client";

/**
 * DxfPipelineSection — section home page « Comment ça fonctionne ? » dédiée
 * au pipeline DXF/DGN réel (cf. `caoPhaseLabel`, `run-job.ts`) : lecture →
 * mappage des calques → polygonisation → jointure spatiale. Remplace
 * l'ancienne section générique WORKFLOW_STEPS (upload → IA → carte →
 * rapport), moins spécifique au traitement CAO effectivement réalisé.
 *
 * Les quatre étapes s'animent en SÉQUENCE sur une horloge globale unique
 * (évolution du traitement, pas quatre boucles indépendantes) : une étape
 * termine et « tient » son résultat pendant que la suivante s'anime, les
 * connecteurs entre cartes s'allument au fur et à mesure — cf. proposition
 * validée en amont (docs de conversation, section « Trait par Trait »).
 *
 * Rendu 100% Canvas (pas de SVG longs à la main, cf. convention design) piloté
 * par un seul rAF ; DOM manipulé par refs (état visuel par frame), jamais par
 * setState — mêmes raisons de performance que le style Leaflet impératif de
 * SectionsClient.tsx (60 re-renders/s sur un tableau serait un contre-sens).
 * Couleurs lues via `getComputedStyle` sur des variables CSS scopées à la
 * section (dérivées des tokens globaux `--foreground`/`--border`/`--ring`…,
 * cf. globals.css) : le thème clair/sombre de l'appli (classes `.dark`/`.light`
 * sur `<html>`, `ThemeProvider.tsx`) s'applique donc automatiquement, sans
 * media query ni logique de thème dupliquée ici.
 */
import { useEffect, useRef } from "react";

type StageKey = "lecture" | "mappage" | "polygonisation" | "jointure";

const STAGES: Array<{
  key: StageKey;
  title: string;
  desc: string;
  out: string;
}> = [
  {
    key: "lecture",
    title: "Lecture",
    desc: "Chaque entité du DXF est décodée calque par calque.",
    out: "1 284 entités",
  },
  {
    key: "mappage",
    title: "Mappage des calques",
    desc: "Les calques sont associés à leur classe cadastrale.",
    out: "4 calques → 3 classes",
  },
  {
    key: "polygonisation",
    title: "Polygonisation",
    desc: "Les segments épars se referment en parcelle valide.",
    out: "1 anneau, 5 sommets",
  },
  {
    key: "jointure",
    title: "Jointure spatiale",
    desc: "La parcelle rejoint sa commune : le NICAD s’assemble.",
    out: "Syscol attribué",
  },
];

// Une SEULE horloge : les étapes s'animent l'une après l'autre (évolution du
// traitement), pas en parallèle — cf. proposition validée.
const STAGE_ACTIVE_MS = 2600;
const STAGE_HOLD_MS = 550;
const STAGE_WINDOW_MS = STAGE_ACTIVE_MS + STAGE_HOLD_MS;
const END_PAUSE_MS = 1100;
const TOTAL_MS = STAGES.length * STAGE_WINDOW_MS + END_PAUSE_MS;

function ease(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Colors {
  ink: string;
  inkDim: string;
  inkFaint: string;
  accent: string;
  accentSoft: string;
  card: string;
  border: string;
  // Nom de police RÉSOLU (ex. "'Geist Mono', 'Geist Mono Fallback'"), pas
  // `var(--font-mono)` — `ctx.font` du Canvas 2D n'évalue PAS les variables
  // CSS, seul du texte de police littéral y est accepté.
  monoFont: string;
  parcel: string;
  parcelSoft: string;
}

/* ── Lecture ────────────────────────────────────────────────────────── */
const LECTURE_SEGS = (() => {
  const rnd = mulberry32(7);
  const out: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    y: number;
  }> = [];
  for (let i = 0; i < 12; i++) {
    const x = 0.1 + rnd() * 0.8,
      y = 0.08 + rnd() * 0.84;
    const len = 0.06 + rnd() * 0.12,
      ang = rnd() * Math.PI * 2;
    out.push({
      x1: x,
      y1: y,
      x2: x + Math.cos(ang) * len,
      y2: y + Math.sin(ang) * len,
      y,
    });
  }
  return out;
})();
function drawLecture(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: number,
  c: Colors,
) {
  const scanY = h * ease(Math.min(p / 0.82, 1));
  for (const s of LECTURE_SEGS) {
    if (s.y * h <= scanY + 4) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(s.x1 * w, s.y1 * h);
      ctx.lineTo(s.x2 * w, s.y2 * h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(0, scanY);
  ctx.lineTo(w, scanY);
  ctx.stroke();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = c.accent;
  ctx.fillRect(0, Math.max(0, scanY - 10), w, 10);
  ctx.globalAlpha = 1;
}

/* ── Mappage des calques ───────────────────────────────────────────── */
const LAYERS = ["LIMITE_PARC.", "NUM_PARCELLE", "AXE_VOIRIE"];
const CLASSES = ["Parcelle", "Numéro", "Ignoré"];
const MATCH = [0, 1, 2];
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  wr: number,
  hr: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + wr, y, x + wr, y + hr, r);
  ctx.arcTo(x + wr, y + hr, x, y + hr, r);
  ctx.arcTo(x, y + hr, x, y, r);
  ctx.arcTo(x, y, x + wr, y, r);
  ctx.closePath();
}
function drawMappage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: number,
  c: Colors,
) {
  const leftX = w * 0.06,
    rightX = w * 0.62;
  const topPad = h * 0.14,
    rowH = (h - topPad * 1.6) / LAYERS.length;
  ctx.font = `9.5px ${c.monoFont}, ui-monospace, monospace`;
  ctx.textBaseline = "middle";

  function chip(x: number, y: number, text: string, hi: boolean): number {
    const wtxt = ctx.measureText(text).width + 14;
    ctx.fillStyle = hi ? c.accentSoft : c.card;
    ctx.strokeStyle = hi ? c.accent : c.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y - 9, wtxt, 18, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = hi ? c.accent : c.ink;
    ctx.fillText(text, x + 7, y + 1);
    return wtxt;
  }

  const leftY = LAYERS.map((_, i) => topPad + rowH * i + rowH / 2);
  const rh = h - topPad * 1.6;
  const rightY = CLASSES.map(
    (_, i) => topPad + (rh / CLASSES.length) * i + rh / (CLASSES.length * 2),
  );

  const per = 1 / LAYERS.length;
  LAYERS.forEach((name, i) => {
    const localP = Math.min(Math.max((p - i * per * 0.7) / (per * 1.4), 0), 1);
    const drawn = ease(localP);
    const y0 = leftY[i],
      y1 = rightY[MATCH[i]];
    ctx.globalAlpha = 0.2 + drawn * 0.8;
    const cw = chip(leftX, y0, name, false);
    ctx.globalAlpha = 1;
    if (drawn > 0.04) {
      const sx = leftX + cw + 2,
        ex = rightX - 10;
      const endX = sx + (ex - sx) * drawn,
        endY = y0 + (y1 - y0) * drawn;
      ctx.strokeStyle = c.inkDim;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(sx, y0);
      ctx.bezierCurveTo(sx + 30, y0, ex - 24, y1, endX, endY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (drawn < 1) {
        ctx.fillStyle = c.accent;
        ctx.beginPath();
        ctx.arc(endX, endY, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  CLASSES.forEach((name, i) => {
    const hi = MATCH.some((m, li) => {
      const localP = Math.min(
        Math.max((p - li * per * 0.7) / (per * 1.4), 0),
        1,
      );
      return m === i && localP > 0.92;
    });
    chip(rightX, rightY[i], name, hi);
  });
}

/* ── Polygonisation ─────────────────────────────────────────────────── */
const PARCEL_PTS = [
  [0.32, 0.2],
  [0.7, 0.16],
  [0.82, 0.56],
  [0.54, 0.84],
  [0.2, 0.6],
].map(([x, y]) => ({ x, y }));
const SEG_START = (() => {
  const rnd = mulberry32(42);
  return PARCEL_PTS.map(() => ({
    dx: (rnd() - 0.5) * 0.9,
    dy: (rnd() - 0.5) * 0.9,
  }));
})();
function drawPolygonisation(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: number,
  c: Colors,
) {
  const n = PARCEL_PTS.length,
    per = 1 / n;
  const pts = PARCEL_PTS.map((t, i) => {
    const localP = ease(
      Math.min(Math.max((p - i * per * 0.55) / (per * 2.2), 0), 1),
    );
    const s = SEG_START[i];
    return {
      x: lerp(t.x + s.dx, t.x, localP) * w,
      y: lerp(t.y + s.dy, t.y, localP) * h,
      done: localP > 0.985,
    };
  });
  const allDone = pts.every((pt) => pt.done);
  if (allDone) {
    ctx.beginPath();
    pts.forEach((pt, i) =>
      i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y),
    );
    ctx.closePath();
    ctx.fillStyle = c.parcelSoft;
    ctx.fill();
    ctx.strokeStyle = c.parcel;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    for (let j = 0; j < n; j++) {
      const a = pts[j],
        b = pts[(j + 1) % n];
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.3;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  pts.forEach((pt) => {
    ctx.fillStyle = pt.done ? c.accent : c.ink;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.done ? 2.6 : 1.8, 0, Math.PI * 2);
    ctx.fill();
    if (pt.done) {
      const pulse = (performance.now() / 260) % 1;
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 1 - pulse;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3 + pulse * 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });
}

/* ── Jointure spatiale ─────────────────────────────────────────────── */
const COMMUNE_PTS = [
  [0.06, 0.3],
  [0.3, 0.06],
  [0.72, 0.1],
  [0.94, 0.42],
  [0.86, 0.82],
  [0.46, 0.94],
  [0.1, 0.7],
].map(([x, y]) => ({ x, y }));
const NICAD_STR = "0143 0121 001 00042";
function drawJointure(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: number,
  c: Colors,
) {
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = c.inkFaint;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  COMMUNE_PTS.forEach((pt, i) => {
    const x = pt.x * w,
      y = pt.y * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  const cx = 0.5 * w,
    cy = 0.46 * h,
    scale = 0.32;
  ctx.beginPath();
  PARCEL_PTS.forEach((pt, i) => {
    const x = cx + (pt.x - 0.5) * w * scale,
      y = cy + (pt.y - 0.5) * h * scale;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = c.parcelSoft;
  ctx.fill();
  ctx.strokeStyle = c.parcel;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const pingP = Math.min(p / 0.55, 1);
  if (pingP < 1) {
    [0, 0.4].forEach((delay) => {
      const lp = Math.min(Math.max((pingP - delay) / (1 - delay), 0), 1);
      if (lp <= 0 || lp >= 1) return;
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 1 - lp;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(cx, cy, lp * w * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }
  if (p > 0.5) {
    const bp = ease(Math.min((p - 0.5) / 0.2, 1));
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = c.accent;
    ctx.globalAlpha = bp;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    COMMUNE_PTS.forEach((pt, i) => {
      const x = pt.x * w,
        y = pt.y * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  if (p > 0.6) {
    const chars = Math.floor(
      ease(Math.min((p - 0.6) / 0.38, 1)) * NICAD_STR.length,
    );
    ctx.font =
      "600 " +
      Math.round(w * 0.058) +
      `px ${c.monoFont}, ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = c.ink;
    ctx.fillText(NICAD_STR.slice(0, chars), w / 2, h - h * 0.06);
    ctx.textAlign = "left";
  }
}

const DRAW: Record<
  StageKey,
  (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    p: number,
    c: Colors,
  ) => void
> = {
  lecture: drawLecture,
  mappage: drawMappage,
  polygonisation: drawPolygonisation,
  jointure: drawJointure,
};

const CHEVRON = (
  <svg
    viewBox="0 0 18 10"
    fill="none"
    aria-hidden="true"
    className="h-[10px] w-[18px]"
  >
    <path
      d="M1 1l8 4-8 4M9 1l8 4-8 4"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default function DxfPipelineSection() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const frameElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const numElsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const canvasElsRef = useRef<Array<HTMLCanvasElement | null>>([]);
  const fillElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const connectorElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const originRef = useRef(0);

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    originRef.current = performance.now();

    const sizes: Array<{ w: number; h: number }> = STAGES.map(() => ({
      w: 200,
      h: 200,
    }));

    function resizeAll() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvasElsRef.current.forEach((canvas, i) => {
        const frame = frameElsRef.current[i];
        if (!canvas || !frame) return;
        const rect = frame.getBoundingClientRect();
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        sizes[i] = { w: rect.width, h: rect.height };
        const ctx = canvas.getContext("2d");
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      });
    }
    resizeAll();
    window.addEventListener("resize", resizeAll);

    // Résolu UNE fois (ne change pas en cours de session) : `--font-geist-mono`
    // (posée par next/font sur <html>, cf. layout.tsx) contient le nom de
    // police déjà résolu, ex. "'Geist Mono', 'Geist Mono Fallback'" — c'est
    // CETTE chaîne littérale qu'il faut passer à `ctx.font`, jamais `var(...)`.
    const monoFont =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-geist-mono")
        .trim() || "ui-monospace";

    function readColors(): Colors {
      const el = wrapRef.current!;
      const cs = getComputedStyle(el);
      const get = (name: string) => cs.getPropertyValue(name).trim();
      return {
        ink: get("--dxf-ink"),
        inkDim: get("--dxf-ink-dim"),
        inkFaint: get("--dxf-ink-faint"),
        accent: get("--dxf-accent"),
        accentSoft: get("--dxf-accent-soft"),
        card: get("--dxf-card"),
        border: get("--dxf-border"),
        parcel: get("--dxf-parcel"),
        parcelSoft: get("--dxf-parcel-soft"),
        monoFont,
      };
    }

    let rafId = 0;
    function frame(now: number) {
      const colors = readColors();
      const cyclePos = reduceMotion
        ? TOTAL_MS
        : (((now - originRef.current) % TOTAL_MS) + TOTAL_MS) % TOTAL_MS;
      const currentIndex = Math.min(
        Math.floor(cyclePos / STAGE_WINDOW_MS),
        STAGES.length,
      );

      STAGES.forEach((s, i) => {
        let state: "pending" | "active" | "done";
        let p: number;
        let pct: number;
        if (i < currentIndex) {
          state = "done";
          p = 1;
          pct = 100;
        } else if (i === currentIndex) {
          const tIn = cyclePos - currentIndex * STAGE_WINDOW_MS;
          p = Math.min(Math.max(tIn / STAGE_ACTIVE_MS, 0), 1);
          state = tIn >= STAGE_ACTIVE_MS ? "done" : "active";
          pct = p * 100;
        } else {
          state = "pending";
          p = 0;
          pct = 0;
        }

        const cardEl = cardElsRef.current[i];
        const frameEl = frameElsRef.current[i];
        const numEl = numElsRef.current[i];
        const canvas = canvasElsRef.current[i];
        const fillEl = fillElsRef.current[i];
        if (cardEl) cardEl.style.opacity = state === "pending" ? "0.32" : "1";
        if (frameEl)
          frameEl.style.borderColor =
            state === "active" ? colors.accent : colors.border;
        if (numEl)
          numEl.style.color =
            state === "active"
              ? colors.accent
              : state === "done"
                ? colors.inkDim
                : colors.inkFaint;
        if (fillEl) fillEl.style.width = pct + "%";

        if (canvas) {
          const ctx = canvas.getContext("2d");
          const { w, h } = sizes[i];
          if (ctx && w > 0 && h > 0) {
            ctx.clearRect(0, 0, w, h);
            DRAW[s.key](ctx, w, h, p, colors);
          }
        }
      });

      connectorElsRef.current.forEach((conn, i) => {
        if (!conn) return;
        conn.style.color = i < currentIndex ? colors.accent : colors.border;
      });

      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resizeAll);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <section className="max-w-7xl mx-auto px-6 py-2">
      {/* <div className="text-center mb-12">
        <h2 className="text-3xl font-bold mb-3">D&apos;un fichier DXF à une parcelle certifiée</h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Un même moteur retrace, calque par calque, le chemin qui va d&apos;un dessin CAO à une parcelle
          cadastrale topologiquement valide et rattachée à sa commune.
        </p>
      </div> */}

      <div
        ref={wrapRef}
        className="relative rounded-2xl border border-border bg-card p-5 md:p-6 shadow-sm"
        style={
          {
            "--dxf-ink": "var(--foreground)",
            "--dxf-ink-dim": "var(--muted-foreground)",
            "--dxf-ink-faint":
              "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
            "--dxf-accent": "var(--ring)",
            "--dxf-accent-soft": "var(--accent)",
            "--dxf-card": "var(--card)",
            "--dxf-border": "var(--border)",
            "--dxf-parcel": "oklch(0.65 0.22 145)",
            "--dxf-parcel-soft": "oklch(0.65 0.22 145 / 0.16)",
          } as React.CSSProperties
        }
      >
        <span className="absolute left-0 top-0 h-4 w-4 border-l-2 border-t-2 border-muted-foreground/40" />
        <span className="absolute right-0 top-0 h-4 w-4 border-r-2 border-t-2 border-muted-foreground/40" />
        <span className="absolute bottom-0 left-0 h-4 w-4 border-b-2 border-l-2 border-muted-foreground/40" />
        <span className="absolute bottom-0 right-0 h-4 w-4 border-b-2 border-r-2 border-muted-foreground/40" />

        <div className="flex flex-col md:flex-row items-stretch">
          {STAGES.map((s, i) => (
            <div key={s.key} className="contents">
              <div
                ref={(el) => {
                  cardElsRef.current[i] = el;
                }}
                className="flex flex-1 min-w-0 flex-col px-1 py-3 md:px-3.5 md:py-1 transition-opacity duration-300"
              >
                <div className="flex items-baseline gap-2 mb-2.5">
                  <span
                    ref={(el) => {
                      numElsRef.current[i] = el;
                    }}
                    className="font-mono text-[11px] font-bold transition-colors duration-300"
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[13.5px] font-bold">{s.title}</span>
                </div>
                <div
                  ref={(el) => {
                    frameElsRef.current[i] = el;
                  }}
                  className="relative aspect-square w-full rounded border border-border bg-background/40 transition-colors duration-300 overflow-hidden"
                >
                  <canvas
                    ref={(el) => {
                      canvasElsRef.current[i] = el;
                    }}
                    className="absolute inset-0 h-full w-full"
                  />
                </div>
                <div className="mt-2.5 h-0.5 w-full rounded-full bg-border relative overflow-hidden">
                  <div
                    ref={(el) => {
                      fillElsRef.current[i] = el;
                    }}
                    className="absolute inset-y-0 left-0 w-0"
                    style={{ background: "var(--ring)" }}
                  />
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                  {s.desc}
                </p>
                <p className="mt-auto pt-2.5 font-mono text-[11px] text-muted-foreground">
                  Sortie{" "}
                  <span className="font-semibold text-foreground">{s.out}</span>
                </p>
              </div>
              {i < STAGES.length - 1 && (
                <div
                  ref={(el) => {
                    connectorElsRef.current[i] = el;
                  }}
                  aria-hidden="true"
                  className="flex flex-none items-center justify-center py-1 md:w-[30px] md:pt-8 text-border transition-colors duration-300"
                >
                  <span className="rotate-90 md:rotate-0">{CHEVRON}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
