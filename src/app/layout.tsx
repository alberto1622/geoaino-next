import type { Metadata } from "next";
import { Bricolage_Grotesque, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AppToaster } from "@/components/AppToaster";
import { Providers } from "@/components/Providers";

// Design system « Graticule » : Bricolage Grotesque (titres, cf. globals.css
// h1/h2/h3) + IBM Plex Sans (corps/UI) + IBM Plex Mono (NICAD, coordonnées, EPSG…).
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], weight: ["500", "600", "700"] });
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: {
    default: "GéoAino — Fiabilisation des données cadastrales",
    template: "%s — GéoAino",
  },
  description: "Détection des erreurs topologiques, correction et rapports d'analyse des données cadastrales du Sénégal.",
  openGraph: {
    title: "GéoAino — Fiabilisation des données cadastrales",
    description:
      "Détection des erreurs topologiques, correction et rapports d'analyse des données cadastrales du Sénégal.",
    type: "website",
    locale: "fr_FR",
    images: [{ url: "/logo-geoaino.png", width: 793, height: 315, alt: "GEO-AINO SUPREME" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "GéoAino — Fiabilisation des données cadastrales",
    images: ["/logo-geoaino.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="fr"
      className={`${bricolage.variable} ${plexSans.variable} ${plexMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("geoaino-theme")||"dark";document.documentElement.classList.add(t);}catch(e){document.documentElement.classList.add("dark");}})();`,
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground" suppressHydrationWarning>
        <Providers>
          {children}
          <AppToaster />
        </Providers>
      </body>
    </html>
  );
}
