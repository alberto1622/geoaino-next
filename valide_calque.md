Ci-dessous nous avons deux exemple de fichier .dgn. Vous verrez les calques et leurs correspondance des champs obtenus pour les données structurées

L'objectif est de récupérer les données pour les champs corresdants sachant que:

- le numéro de parcelle, numero_parcelle, contient 5 caractères numerique et se trouve dans limites_parcelles
- le numero de lot, numero_lot, se trouve dans limites_parcelles
- les parcelles se trove dans limites_sections avec le numero_section correspondants
- proprietaire se trouve dans la parcelle
- s'il y a presence du calque piscine ou quelque chose de ce genre, récupérer ses coordonnées, et remplisser les champs is_piscine, piscine_surface

NB: il faudra généraliser le traitement de ce type de fichier

### Limite Parcelle Saly Ngap Section 042

- LIMITE_PARCELLES_SALY_NGAP --> limites_parcelles
- numero_lot --> numero_lot
- numero_parcelle, numero parcelle --> numero_parcelle en 5 caractères numérique,qui va permettre de contruire le nicad
- PICINES --> is_piscine, piscine_surface : recuperer la superficie
- PROPRIÉTAIRE, PROPRIETAIRE MAJ, PROPRIETAIRE --> proprietaire
- Sections Polygon --> limites_sections
- numero_section --> numero_section

### FICHIER RUFISQUE 29 12 2023 CORR

- Parcelles_Ruf --> limites_parcelles
- N°PARCELLE, N°Parcelles --> numero_parcelle en 5 caractères numérique
- Numero section --> numero_section
- Numero lot, NUMERO D, N°LOT --> numero_lot
- sections Rufisque 2016 --> limites_sections
- PROPRIETAIRES --> proprietaire
