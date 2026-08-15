Analyser moi la polygonisation des sections du fichier PLAN-CADASTRAL*KAOLACK_FINAL*-11-12-2025.dxf sur la récupération des sections 013 et 018 de la commune de THIARE.
Le résultat que j'ai est qu'il fusionne les deux en 013. Alors qu'il doit les séparées

## 13/08/2025

Voici le contexte pour le traitement des fichiers shapefile (.shp):

- coloumns : ['région', 'départeme', 'commune', 'VillageQua', 'CodeSectio',
  'lotissemen', 'NumLot', 'numParcell', 'nicad', 'SupLegale', 'SupBatie',
  'TypeBatie', 'NbNivBat', 'SupNbatie', 'TypeDestin', 'Catocup',
  'SourceDonn', 'TitreMere', 'TypeDocFon', 'NatJuri', 'TitulaireD',
  'IdTitulair', 'Occupant', 'IdOccupant', 'ValLocativ', 'SupRelle',
  'Numéro_de', 'Date_de_d', 'E_mail', 'TitreParce', 'SupReelle',
  'adresse', 'TOPONYMIE', 'Shape_Leng', 'Shape_Area', 'geometry']

- Objectif:
  - proposer un mappage sur les champs à récupérer
  - récupérer les champs lors du traitement: region, departement, commune, Quartier,
    numero_section(codesection), numero_lot, numero_parcelle, nicad, superficie
  - Effectuer une jointure geospatial avec la table section de la gestion des sections, vérifier la correspondance avec numero_section (si oui attribuer la secion, si non considérer comme une erreur et proposer une correction: attribution)
