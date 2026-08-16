# Gestion des sections

La gestion des sections est promordiales pour la gestion des parcelles car elle permet de geolocaliser les parcelles et de construire les nicad à partir du syscol, numéro section et numéro parcelle.
On peut les contruire en chargeant des fichiers de type shapefile ou dxf.

# Gestion des parcelles

## Traitement des shapefiles et dxf

### 1. Selection des parcelles en shapefile

![alt text](image-1.png)
Après selection, le processus démarre automaitquement et la table attributaire se trouvant dans le fichier .dbf sera récupérer pour éffectuer le mappage.

### 2. Mappage des champs

![alt text](image-2.png)

Après mappage, vous pouvez lancer le traitement
![alt text](image-3.png)

### 3. Présentation des résultats

![alt text](image-4.png)

### 4. Afficher des parcelles dans le map

![alt text](image-5.png)

En nous avons les parcelles dont le numero_section ne corresponds pas au numero_section de la table section

## 5. Les types d'erreurs

### 5.1 - Parcelle avec plus d'un numéro

Sur l'image ci-après, la parcelle contient deux numeros parcelles (00525-00526).
![alt text](image-6.png)
Cette erreur est dû au fait que le calques "numéro parcelle" a été utilisé pour créer la délimitation des deux parcelles visibles sur l'images ci-dessous.
![alt text](imges-7.jpeg)

#### Vérifiction sur microstation nécessaire

Il est necessaire de fait une vérification depuis les plans de microstation pour appliquer des modifications.
Exemple: la parcelle ci après contient 2 numero (00447-00702) et on peut voir la mention "NICD MERE" sur l'une.
![alt text](image-8.png)

### Duplication de numero parcelle

Dans cette parcelle, la première parcelle contient un numéro qui est dupliqué dans la deuxieme. Ce dernier contient deux numéro.
![alt text](image-9.png)

**Remarque:** Les erreurs duplications, plusieurs numero et numéro manquant d'une parcelle sont souvant liées entre eux.
