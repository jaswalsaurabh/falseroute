# Stage 1: Build & Prune
FROM node:24.19.0-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.22.0

WORKDIR /app

# Copy root workspace manifests and lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY scripts/prisma-guard.ts ./scripts/

# Copy required package manifests and source
COPY packages/ ./packages/
COPY apps/worker/ ./apps/worker/
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY tests/integration/package.json ./tests/integration/package.json

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Generate Prisma client and build Worker dependencies
RUN pnpm --filter @false-route/database build
RUN pnpm --filter @false-route/worker build

# Prune for production deployment
RUN pnpm --filter @false-route/worker --prod --legacy deploy /app/pruned

# Stage 2: Production Runtime
FROM node:24.19.0-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy pruned production application from builder stage
COPY --from=builder --chown=node:node /app/pruned ./

USER node

CMD ["node", "dist/index.js"]
