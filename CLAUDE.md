<!-- claude-code-setup:begin — DO NOT EDIT THIS SECTION -->
## Next.js Conventions

- Use the App Router (app/) for new pages unless the project uses Pages Router
- Prefer Server Components by default; use 'use client' only when needed
- Use Next.js built-in Image, Link, and Font components
- TypeScript strict mode is expected

## Code Quality

- Linter: eslint (`npx eslint .`)
- Fix lint errors before committing

## Code Changes

- Make minimal, targeted changes — only modify what is explicitly asked
<!-- claude-code-setup:end -->

@AGENTS.md

## Documentation continue des concepts de traitement

**Toujours documenter les concepts vus lors des traitements de fichiers
géométriques, géospatiaux et topologiques** (lecture CAO/DXF/DGN, polygonisation,
topologie, dédoublonnage, NICAD, jointures spatiales, etc.).

Règle à appliquer à chaque nouveau concept ou correctif de ce type :

1. Ajouter / mettre à jour une section dans **`docs/CONCEPTS-TRAITEMENT-DXF.md`**
   (retours de terrain). Pour le socle théorique, enrichir plutôt
   `docs/SUPPORT-COURS-GEOMATIQUE.md`.
2. Pour chaque concept, documenter : **le problème métier, la cause technique, la
   solution (`fichier · fonction`) et le « pourquoi »** (pièges inclus).
3. Référencer tout nouveau document depuis **`docs/README.md`** (table + parcours
   de lecture).
4. En cas de divergence doc/code, **le code (`src/lib/**`) fait foi** : mettre la
   doc à jour en conséquence.
