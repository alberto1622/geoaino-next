This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 06/082026

- ✅Corriger la superficie sur les erreurs topologiques
  - ✅A tester

- ✅ correction directe des erreurs topologiques
  - corrections manuelles implémenter

- ✅Ajouter un module veriCAD
  - il faudra intégrer la base syscol avec les communes correspondants

- Ajouter des fichiers d'extension .dgn

- Sur la map:
  - ✅Faire clignoté la parcelle avec erreur selectionnée
  - ✅Recherche suivant le nicad
  - ✅Ajouter de la table attributaire des parcelles selectionnées

- ✅Afichage des données dans une table
  - ✅Avec possibilité de supprimer des lignes

## 18/06/2026

- ✅il faudra intégrer la base syscol 2026 avec les communes correspondants
- Augmenter la capacité de chargement des données

## 21/06/2026

- Mettre un code les non-correspondance en couleur différents
- Ajouter les syscol pour la formation des nicad des fichiers .dxf

- ✅Corriger les codes couleurs sur les types d'erreurs sur les parcelles (erreurs colorées par type dès le chargement + parcelles intactes en vert)
- ✅Ajouter une mode édition sur les doublures
- revoir la génération

- Migration de masse de 2013 à 2026
  Ex: charger un fichier de 2013 et générer la correspondance de 2026

- Vérifier si un numero de nicad (charger un fichier) est conforme au découpage administrative

### 26/07/2026

- Recharger le fichier de Diourbel pour revoir les corrections
- Appliquer une historique pour retourner vers les précédents modifs
- Afficher par couches (les couches communes, region, section, parcelle)
- Controler le numero section et parcelle
- Contruire les nicad en effectuant des incrémentation suivant le dernier nicad ou parcelle

claude --worktree edition-numero-sections --resume 26a0d07b-4c68-4849-8025-05b771bd8ef7

- ✅Ajouter l'ajout de section à partir de shape file
- ✅Appliquer la polygonisation lors de la construction des sections
- ✅Appliquer la possibilité de mise à jour automatique des nicad d'une numero de section ajouter ou modifier
- ✅Ajouter l'affichage des numero_section dans le map cadastre/sections
- Qiusheng Wu - Building open-source tools for geospatial data science and GeoAI

# Notes — Gestion Cadastrale / Sections / Parcelles

**Date : 11/08/2026**

---

## 1. Limites de section → Gestion des sections

**Parcelles :**

- → ✅Activer la barre d'évolution
- → ✅Effectuer les mêmes corrections avec les shapefiles que...
- → ✅Ajouter le mappage des fichiers .shp
- Web-cache pour charger de gros volumes de données WFS
- → Ajouter le départage des départements, syscol
- ✅Dans la liste déroulante, "Lot stocké :" Ajouter la possibilité de selection/deselectionner des lots
- ✅Vérifier les chevauchments et intersections entre les sections chargés et existant déjà

## claude --resume cf625d72-d092-4437-b99f-7ae0525999ac

## 2. Parcelle / Titre foncier — Plan cadastral / Plan foncier

- → ✅Signaler l'erreur suivant: limites parcelles avec 2 numéros de parcelles et permettre à l'utilisateur de choisir un numéro
- → ✅Il y a des numeros parcelles qui commence ou déborde un peu dans une autre parcelle, récupérer les même dans la parcelle où il occupe plus de place
- → Désactiver les limites sections
- → ✅Récupérer les sections depuis la base de données des sections

## RECHARGER LE FICHIER PLAN CADASTRAL PIKINE.DXF CAR IL Y A CERTAINS NICAD N'ONT RECUPERER

## 3. Vérification du NICAD

- → ✅Ajouter de quel syscol il s'agit : 2013 / 2026
- → ✅Basculement :
  - Niveau : 2013 syscol
  - syscol 2026
  - Niveau section

---

## 4. Points du 11/08/2026

- → Gérer les contraintes sur le n° section (3 caractères)
- → ✅Loading lors des modifications
- → Identifier et exporter les sections ayant des anomalies
<<<<<<< HEAD
- → Sélection suivant les fichiers
- → ✅Corriger l'affichage (Mark)
- → Chevauchement / Intersection
- → Différencier les gaps et les chevauchements
- → ✅Effectuer le mappage des champs avant le traitement

# Problèmes

## 1. intersections des sections entre deux fichiers charger

A véfifier
=======
- → ✅Sélection suivant les fichiers
- → Corriger l'affichage (Mark)
- → ✅Chevauchement / Intersection
- → ✅Différencier les gaps et les chevauchements
- → ✅Effectuer le mappage des champs avant le traitement
>>>>>>> worktree-shapefile-parcelles-section-coherence
