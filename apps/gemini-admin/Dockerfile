FROM node:24.19.0-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.22.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY scripts/prisma-guard.ts scripts/reset-staging-gemini-budget.ts ./scripts/
COPY packages/database/ ./packages/database/
COPY packages/typescript-config/ ./packages/typescript-config/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @false-route/database build
RUN pnpm --filter @false-route/database --prod --legacy deploy /app/pruned

FROM node:24.19.0-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/pruned ./
COPY --from=builder --chown=node:node /app/packages/database/dist ./packages/database/dist
COPY --from=builder --chown=node:node /app/scripts/reset-staging-gemini-budget.ts ./scripts/reset-staging-gemini-budget.ts

USER node

CMD ["node", "scripts/reset-staging-gemini-budget.ts"]
