# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json ./
COPY pnpm-lock.yaml* ./
RUN pnpm install --prod --no-frozen-lockfile && pnpm store prune
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main"]
