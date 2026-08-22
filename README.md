# FalseRoute

> **Status: Active Engineering Implementation**

FalseRoute is an autonomous cyber-deception and containment control-plane designed to ingest simulated intrusion signals, evaluate events against deterministic deception policies, record simulated false-route assignments to decoy targets, and provide transparent provenance and auditability for security operators.

---

## Architectural Principles

FalseRoute strictly maintains containment and provenance boundaries:

1. **Deterministic Containment Boundary**: Pure domain policy governs all deception actions. Gemini model outputs are treated as untrusted advisory enrichments and can never override deterministic policy or assign non-decoy assets to false routes.
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

## Local Development Quickstart

### Prerequisites

- **Node.js**: `24.19.0` (managed via `.nvmrc`)
- **pnpm**: `11.22.0`
- **Docker & Docker Compose**: For local PostgreSQL container

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

The default `.env.example` includes synthetic development credentials:

- `OPERATOR_ACCESS_TOKEN=not-a-real-local-operator-token`
- `DATABASE_URL=postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_dev?schema=public`

### 3. Start Local Infrastructure

Start the containerized PostgreSQL database service:

```bash
pnpm dev:infra
```

### 4. Run Database Migrations

Apply development migrations safely through the guarded migration runner:

```bash
pnpm dev:migrate
```

_(Optional)_ Prepare the isolated test database for local integration testing:

```bash
pnpm db:setup:test
```

### 5. Start Development Environment

Launch Web, API, and Worker under the local-development supervisor:

```bash
pnpm dev
```

The supervisor:

- Loads the root `.env`.
- Builds workspace dependencies using cached Turborepo tasks.
- Spawns Web, API, and Worker concurrently with prefixed logs (`[web]`, `[api]`, `[worker]`).
- Supervise all processes, forwarding `SIGINT`/`SIGTERM` and cleaning up child processes upon exit.

### 6. Access and Test

1. Open `http://localhost:5173` in your browser.
2. Unlock the controlled demonstration using `not-a-real-local-operator-token`.
3. In the **Intrusion Event Simulator**, select a preset (e.g., **Decoy Credential Trigger**).
4. Submit the event and observe the Worker process and transition it from `PENDING` to `DECIDED`.

### 7. Stopping Services & Infrastructure

- **Stop Development Services**: Press `Ctrl+C` in the terminal running `pnpm dev`. The supervisor terminates all child processes cleanly without leaving orphan processes.
- **Stop Database Infrastructure**: When finished, stop local Docker Compose services:

```bash
pnpm dev:infra:down
```

---

## Optional Individual Service Commands

If you wish to run individual components in isolation:

| Command               | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev:web`        | Start only the React/Vite web server (`http://localhost:5173`)                     |
| `pnpm dev:api`        | Load `.env` and start only the Express API in watch mode (`http://127.0.0.1:3000`) |
| `pnpm dev:worker`     | Load `.env` and start only the background Worker in watch mode                     |
| `pnpm dev:services`   | Start API and Worker concurrently without Web                                      |
| `pnpm dev:migrate`    | Load `.env` and run guarded Prisma migrations                                      |
| `pnpm dev:infra`      | Start local PostgreSQL container in background                                     |
| `pnpm dev:infra:down` | Stop local PostgreSQL container                                                    |

---

## Troubleshooting

### Port 3000 already in use

Another process is listening on the default API port. Stop the conflicting process or specify an alternative port in your `.env` (e.g. `PORT=3001`) and adjust `VITE_API_TARGET=http://127.0.0.1:3001`.

### Port 5173 already in use

Another process is using Vite's default dev server port. Vite will automatically offer or select the next available port (e.g., 5174). Make sure CORS origins in `.env` include the active frontend port if modified.

### PostgreSQL unavailable

Ensure Docker is running and execute:

```bash
pnpm dev:infra
```

Verify container status with `docker ps` to ensure container `falseroute-postgres-local` is healthy on port `5434`.

### Migration not applied

If the API or Worker fails to start with relation/table errors, run:

```bash
pnpm dev:migrate
```

### Missing operator token / Unauthorized in dashboard

Ensure `.env` contains `OPERATOR_ACCESS_TOKEN=not-a-real-local-operator-token` (must be at least 8 characters) and that you enter this exact token on the dashboard unlock screen.

---

## Running Quality Gates & Tests

```bash
# Run all static checks, typechecks, builds, unit tests, and repo governance
pnpm check

# Run all unit tests including script suites
pnpm test

# Run database integration tests (requires PostgreSQL running)
pnpm db:setup:test
TEST_DATABASE_URL="postgresql://falseroute:falseroute@127.0.0.1:5434/falseroute_test?schema=public" pnpm test:integration

# Verify production container packaging, non-root user, read-only FS, and smoke tests
pnpm verify:containers

# Validate declarative Cloud Run service templates and zero-secret policies
pnpm check:templates

# Scan tracked and unignored repository files for secrets and credentials
pnpm check:secrets
```
