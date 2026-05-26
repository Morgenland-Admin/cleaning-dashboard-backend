# syntax=docker/dockerfile:1.7
# Multi-stage build: deps -> build -> runtime. Designed for Dokploy on a VPS.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml* tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm run build && pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --chown=app:app package.json ./
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/health || exit 1
# Run migrations on boot, then start the server. Drizzle migrations are
# idempotent (tracked in __drizzle_migrations) so this is safe across restarts.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
