# Stage 1: Build Static Assets
FROM node:24.19.0-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.22.0

WORKDIR /app

# Copy root workspace manifests and lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./

# Copy required package manifests and source for web build
COPY packages/contracts/ ./packages/contracts/
COPY packages/typescript-config/ ./packages/typescript-config/
COPY apps/web/ ./apps/web/
COPY assets/branding/ ./assets/branding/
COPY packages/config/package.json ./packages/config/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/security/package.json ./packages/security/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY tests/integration/package.json ./tests/integration/package.json

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Build the web application and every workspace dependency first.
RUN pnpm --filter @false-route/web... build

# Stage 2: Production Static Server Runtime
FROM node:24.19.0-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy built static distribution and lightweight static server
COPY --from=builder --chown=node:node /app/apps/web/dist ./dist
COPY --from=builder --chown=node:node /app/apps/web/server.ts ./server.ts

USER node

EXPOSE 8080

CMD ["node", "server.ts"]
