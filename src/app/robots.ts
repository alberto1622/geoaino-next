import type { MetadataRoute } from "next";

// Outil métier interne (données cadastrales, accès sur compte) : aucune page
// n'a vocation à être indexée. Complété par `robots: { index: false }` dans
// les métadonnées de layout.tsx. Pas de sitemap pour la même raison.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
