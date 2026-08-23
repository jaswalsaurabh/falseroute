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
COPY apps/api/ ./apps/api/
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY tests/integration/package.json ./tests/integration/package.json

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Build the API and every workspace dependency first. The recursive filter
# ensures each package emits its dist declarations before TypeScript resolves it.
RUN pnpm --filter @false-route/api... build

# Prune for production deployment
RUN pnpm --filter @false-route/api --prod --legacy deploy /app/pruned

# Stage 2: Production Runtime
FROM node:24.19.0-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy pruned production application from builder stage
COPY --from=builder --chown=node:node /app/pruned ./

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
