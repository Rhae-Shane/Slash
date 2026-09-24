# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY openapi ./openapi
RUN npx prisma generate \
  && npx tsx scripts/generate-openapi.ts \
  && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi ./openapi

EXPOSE 3001
USER node
CMD ["node", "dist/index.js"]
