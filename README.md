# FalseRoute

> **Status: Active Engineering Implementation**

FalseRoute is an autonomous cyber-deception and containment control-plane designed to ingest simulated intrusion signals, evaluate events against deterministic deception policies, safely redirect adversaries to simulated false-route targets, and provide transparent provenance and auditability for security operators.

---

## Architectural Principles

FalseRoute strictly maintains containment and provenance boundaries:

1. **Deterministic Containment Boundary**: Pure domain policy governs all deception actions. Gemini model outputs are treated as untrusted advisory enrichments and can never override deterministic policy or redirect non-decoy assets.
2. **Strict Provenance Tracking**: Every data point explicitly models its source provenance:
   - `OBSERVED`: Ground-truth ingested event telemetry.
   - `DERIVED`: Deterministic rule evaluations by the policy engine.
   - `INFERRED`: Advisory AI model suggestions.
   - `UNAVAILABLE`: Degraded or timed-out external provider responses.
3. **Atomic Task Allocation**: PostgreSQL `FOR UPDATE SKIP LOCKED` transactional semantics guarantee that competing worker instances process events safely without duplicates.
4. **Three-Tier Design Tokens**: Web UI styling strictly complies with primitive, semantic, and component token tiers without hardcoded raw colors.

---

## Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [Threat Model](docs/architecture/threat-model.md)
- [Engineering Principles](docs/architecture/engineering-principles.md)
- [Quality Gates](docs/architecture/quality-gates.md)
- [Frontend Architecture](docs/architecture/frontend.md)

---

## Workspace Structure

```text
├── apps/
│   ├── api/             # Express 5 REST API control plane
│   ├── web/             # React 19 / Vite operator dashboard
│   └── worker/          # Background policy engine & orchestration worker
├── packages/
│   ├── config/          # Typed environment parsing & schemas
│   ├── contracts/       # Canonical Zod boundary schemas & types
│   ├── database/        # Prisma 7 schema, migrations, & client
│   ├── observability/   # Pino logging & OpenTelemetry with log redaction
│   ├── security/        # Constant-time operator token verification
│   └── typescript-config/ # Shared strict TypeScript configurations
├── tests/
│   └── integration/     # Full-pipeline system integration test suite
└── infrastructure/
    └── docker/          # Local containerized infrastructure
```

---

## Quickstart

### Prerequisites

- Node.js `24.19.0`
- pnpm `11.22.0`
- Docker & Docker Compose (for local PostgreSQL)

### 1. Start Local Infrastructure

```bash
docker compose -f infrastructure/docker/compose.yml up -d
```

### 2. Install Dependencies & Run Database Migrations

```bash
# Installs workspace dependencies and configures Husky pre-commit hooks
pnpm install

# Deploy schema to development database
DATABASE_URL="postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public" pnpm --filter @false-route/database migrate:deploy

# Idempotently create and migrate test database on existing or new containers
pnpm db:setup:test
```

### 3. Start Development Services

```bash
# In separate terminal sessions or concurrently:
pnpm --filter @false-route/api dev
pnpm --filter @false-route/worker dev
pnpm --filter @false-route/web dev
```

---

## Running Quality Gates & Tests

```bash
# Run all static checks, typechecks, builds, unit tests, and repo governance
pnpm check

# Run all unit tests
pnpm test

# Prepare test database (if not already done) & run integration suites serially
pnpm db:setup:test
TEST_DATABASE_URL="postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_test?schema=public" pnpm test:integration

# Run 3-tier design token validation
pnpm check:design-tokens

# Scan tracked and unignored repository files for secrets and credentials
pnpm check:secrets
```

---

## Controlled Demonstration Workflow

1. Navigate to the Web Dashboard at `http://localhost:5173`.
2. Unlock the controlled demonstration session using the configured `OPERATOR_ACCESS_TOKEN`.
3. In the **Intrusion Event Simulator**, select an attack preset:
   - **Decoy Credential Trigger**: Uses fictional credential `mock-admin-decoy-creds` on `mock-admin-portal` to trigger deterministic false-route assignment (`mock-admin-decoy`).
   - **Standard Access**: Non-decoy control event triggering observation.
   - **High-Frequency Anomaly**: Non-decoy anomaly triggering operator alerting.
4. Submit the event and observe real-time background transition from `PENDING` to `DECIDED`.
5. Inspect the event to review the deterministic action, matched policy rule, audit record (`ruleVersion: 2026.08.1`), and model enrichment or degraded fallback state.
