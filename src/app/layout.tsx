import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { Providers } from "@/components/Providers";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "GEO-AINO SUPREME™ — Plateforme IA de Fiabilisation Cadastrale",
  description: "Détection automatique des erreurs topologiques, correction intelligente et rapport d'expertise des données cadastrales.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="fr"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("geoaino-theme")||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.classList.add(t);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground" suppressHydrationWarning>
        <Providers>
          {children}
        </Providers>
        <Toaster theme="dark" richColors position="top-right" />
      </body>
    </html>
  );
}
