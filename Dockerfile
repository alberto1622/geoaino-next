# syntax=docker/dockerfile:1

# --- Base : Node + GDAL standard (ogr2ogr / ogrinfo pour DGN v7 et DXF) ---
FROM node:22-alpine AS base
RUN apk add --no-cache gdal gdal-tools libc6-compat
WORKDIR /app

# --- (Optionnel) Support DGN v8 via convertisseur externe -------------------
# GDAL standard ne lit que le DGN v7 (et ODA File Converter ne fait que DWG/DXF).
# Le DGN v8 (Microstation V8) exige un outil tiers capable de le LIRE. L'app le
# délègue à une commande externe configurée par variables d'environnement ; le
# DXF produit est ensuite routé vers le pipeline DXF complet.
#   DGN_TO_DXF_BIN   = exécutable du convertisseur (active la fonctionnalité)
#   DGN_TO_DXF_ARGS  = arguments, jetons {input}/{output}
#                      (défaut "-f DXF -skipfailures {output} {input}")
# Backends possibles (à installer/licencier dans l'image) :
#   • GDAL compilé avec le driver DGNv8 (librairies ODA, adhésion ODA requise)
#   • MicroStation en batch via un script wrapper {input} {output}
# Sans configuration, les DGN v7 restent gérés par GDAL et les DGN v8 affichent
# un message demandant une conversion manuelle.

# --- Dépendances ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- Build ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# --- Image finale ---
FROM base AS runner
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
