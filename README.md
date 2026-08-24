<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/branding/false-route-fox-logo-reversed.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/branding/false-route-fox-logo.svg" />
  <img src="assets/branding/false-route-fox-logo.svg" alt="FalseRoute" width="420" />
</picture>

### Safe, explainable cyber deception for testing intrusion response—without touching real systems.

[Architecture](#architecture) · [Local setup](#local-development) · [Scenarios](#scenario-catalog) · [Security](#security-boundaries) · [Quality gates](#quality-gates)

![CI](https://github.com/jaswalsaurabh/falseroute/actions/workflows/ci.yml/badge.svg)
![Node.js](https://img.shields.io/badge/Node.js-24.19.0-5FA04E?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Google Cloud Pub/Sub](https://img.shields.io/badge/Google%20Cloud-Pub%2FSub-4285F4?logo=googlecloud&logoColor=white)
![Cloud Run](https://img.shields.io/badge/runtime-Cloud%20Run-4285F4?logo=googlecloud&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## Problem and approach

Imagine a security team receives a suspicious signal but does not yet know whether it is harmless, malicious, or part of a larger attack. FalseRoute lets the team safely test that situation with fictional data and a fixed set of scenarios.

Instead of changing a real network or customer system, FalseRoute records what happened, checks the evidence, evaluates possible responses, and shows the result in an operator dashboard. It can also record a simulated deception response, such as presenting a decoy route, so people can study the workflow without putting production systems at risk.

### The problem

Security tools can produce alerts, but an alert alone does not explain what should happen next. Teams need to know:

- What signal was received?
- Which facts were directly observed, and which were inferred?
- Why was a response recommended or rejected?
- What would happen if a dependency failed or the same event arrived twice?

FalseRoute makes those questions visible in one traceable workflow.

### How FalseRoute helps

1. A person chooses a safe, pre-built intrusion scenario.
2. FalseRoute validates and records the scenario as an event.
3. Its worker evaluates the evidence using deterministic policy—rules owned by the application—not AI alone.
4. Gemini may provide additional analysis, but it can only recommend actions from a closed tool catalog.
5. The dashboard shows the decision, evidence, activity, and simulated effect, including failures or degraded states.

Nothing in this workflow claims to contain a real attacker or redirect real customer traffic.

### Terms used in this README

| Term                       | Plain-language meaning                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Control plane**          | The part of a system that coordinates decisions and records what happened.                                                |
| **Synthetic scenario**     | Fictional test data created to imitate a security event safely.                                                           |
| **Decoy**                  | A simulated resource designed to attract or observe activity in the demonstration.                                        |
| **False route**            | A recorded simulated assignment that represents where activity could be sent; it is not a real network redirect.          |
| **Deterministic policy**   | Explicit application rules that produce a predictable decision from the available evidence.                               |
| **Bounded AI assistance**  | AI used within strict limits: it can advise, but it cannot choose arbitrary tools, resources, identities, or credentials. |
| **Provenance**             | A record of where a value came from and whether it was observed, calculated, inferred, or unavailable.                    |
| **At-least-once delivery** | A message may arrive more than once, so the system must safely recognize duplicates.                                      |

## Why FalseRoute?

Security operations often have plenty of alerts and too little context. FalseRoute is a small, observable control plane for exploring what happens when an intrusion signal becomes a bounded response workflow:

1. An operator selects a fixed synthetic scenario.
2. The API validates and records the event.
3. A worker evaluates the evidence with deterministic policy and optional Gemini enrichment.
4. The Web console streams the decision, provenance, activity, and simulated effects.

The result is a traceable workflow that is useful for demonstrations, policy design, failure testing, and security engineering—without pretending to control customer traffic or production infrastructure.

## What it does

| Capability                  | What you get                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| **Scenario injection**      | Fixed, validated intrusion presets instead of arbitrary payloads                         |
| **Deterministic policy**    | One application-owned decision for every response action                                 |
| **Bounded AI assistance**   | Gemini can enrich evidence and recommend from a closed tool catalog                      |
| **Durable workflow state**  | PostgreSQL-backed events, decisions, retries, leases, and audit records                  |
| **Live operator console**   | React dashboard with event activity, decisions, and streaming updates                    |
| **Failure-aware execution** | Timeouts, bounded retries, concurrency limits, degraded states, and redacted diagnostics |
| **Cloud-shaped deployment** | API, worker, and Web services packaged for Cloud Run with Secret Manager references      |

## What it deliberately does not do

- It does not proxy real customer traffic.
- It does not execute arbitrary model-generated commands.
- It does not let Gemini choose cloud resources, identities, destinations, or credentials.
- It does not claim exactly-once message delivery.
- It does not turn a simulated route assignment into a real containment action.
- It is not production-ready by default; staging, identity, cost, and threat-model gates remain explicit.

## Architecture

```mermaid
flowchart LR
    Operator[Operator] --> Web[React operator console]
    Web -->|Authenticated scenario| API[Express API]
    API -->|Validated event| Events[(PostgreSQL)]
    API -->|At-least-once transport| PubSub[Pub/Sub]
    PubSub --> Worker[Workflow worker]
    Worker --> Policy[Deterministic policy]
    Worker --> Gemini[Bounded Gemini adapter]
    Gemini -. advisory only .-> Policy
    Policy --> Audit[(Activity + audit records)]
    Audit --> Web
    Policy --> Sim[Simulated deception adapters]
    Sim -. recorded effect .-> Audit
```

### The important boundary

FalseRoute treats provider output as untrusted input. The worker validates every model response at the adapter boundary, then deterministic application policy narrows, authorizes, or rejects the recommendation. Provenance remains visible throughout the workflow:

- `OBSERVED` — supplied by the synthetic event or transport.
- `DERIVED` — calculated by deterministic application rules.
- `INFERRED` — advisory model enrichment.
- `UNAVAILABLE` — a bounded provider failure or degraded result.

## Scenario catalog

The simulator exposes a fixed catalog. Each preset defines its evidence shape, allowed actions, risk bounds, and negative-control behavior.

| Scenario                      | Demonstrates                                              |
| ----------------------------- | --------------------------------------------------------- |
| `.env` configuration probe    | Web decoy recommendation and false-route simulation       |
| WordPress configuration probe | Template-specific deception policy                        |
| Suspicious IP burst           | Bounded alert and quarantine recommendation               |
| SIP INVITE flood              | Telemetry and policy evaluation without SIP proxying      |
| Administrative token tamper   | Rejection, alerting, and bounded quarantine behavior      |
| Path traversal probe          | Evidence validation and web decoy response                |
| Decoy credential use          | Canonical `mock-admin-decoy` assignment in simulated mode |

## Local development

### Prerequisites

- Node.js `24.19.0` — see `.nvmrc`
- pnpm `11.22.0`
- Docker Desktop with Docker Compose

### Start the project

```bash
pnpm install
cp .env.example .env
pnpm dev:infra
pnpm dev:migrate
pnpm dev
```

Then open [http://localhost:5173](http://localhost:5173).

The committed environment example is local-only and uses unmistakably synthetic values. It does not contain production credentials. The default local database is exposed on port `5434`; the Web app runs on `5173`, the API on `3000`, and the worker health server on `8088`.

To stop the stack:

```bash
pnpm dev:infra:down
```

### Try the workflow

1. Unlock the console with the synthetic local operator token from `.env.example`.
2. Open the scenario simulator.
3. Select a fixed preset such as **Decoy Credential Trigger**.
4. Submit the event.
5. Follow the event from ingestion to decision in the activity stream.

### Run one service at a time

| Command               | Purpose                       |
| --------------------- | ----------------------------- |
| `pnpm dev:web`        | Start the Web dashboard       |
| `pnpm dev:api`        | Start the API                 |
| `pnpm dev:worker`     | Start the worker              |
| `pnpm dev:services`   | Start API and worker together |
| `pnpm dev:migrate`    | Run guarded local migrations  |
| `pnpm dev:infra`      | Start local PostgreSQL        |
| `pnpm dev:infra:down` | Stop local PostgreSQL         |

## Repository map

```text
apps/
├── api/                  Express control-plane API
├── web/                  React + Vite operator dashboard
└── worker/               Event processor, policy engine, and adapters

packages/
├── config/               Typed environment parsing
├── contracts/            Canonical Zod contracts and scenario catalog
├── database/             Prisma schema, migrations, and repositories
├── observability/        Pino logging and OpenTelemetry boundaries
├── security/             Authentication and IAM policy rules
└── typescript-config/    Shared strict TypeScript configuration

infrastructure/
├── cloud-run/            Declarative Cloud Run templates
├── docker/               Local PostgreSQL infrastructure
└── terraform/            Staging infrastructure modules

tests/integration/        Cross-application integration coverage
```

## Technology

- **Runtime:** Node.js 24, TypeScript, pnpm, Turborepo — runs the application and manages the monorepo.
- **API:** Express 5 — receives validated requests and exposes the control-plane endpoints.
- **UI:** React 19, Vite, Vitest — builds the operator dashboard and tests the Web experience.
- **Contracts:** Zod schemas with shared typed boundaries — checks that data has the expected shape before it moves between services.
- **Persistence:** PostgreSQL, Prisma 7 — stores events, decisions, retries, leases, and audit records durably.
- **Async transport:** Google Cloud Pub/Sub — moves events between the API and worker without requiring both to run at the same time.
- **AI adapter:** Gemini through a bounded provider boundary — adds optional analysis while application policy remains in control.
- **Deployment:** Cloud Run, Artifact Registry, Cloud SQL, Secret Manager, Terraform — packages, hosts, and configures the services in Google Cloud.
- **Observability:** Pino and OpenTelemetry interfaces — make service activity and failures easier to inspect.

## Security boundaries

Security is part of the workflow rather than a later layer. FalseRoute applies:

- Authentication and authorization at API boundaries.
- Strict scenario and evidence validation.
- Closed tool catalogs with deterministic authorization.
- Secret Manager references for deployed runtime secrets.
- Redacted logs and bounded error details.
- Rate, size, concurrency, retry, timeout, and spend controls.
- Non-root, production-oriented container verification.
- Explicit ownership and provenance for derived decisions.

Please do not report a vulnerability in a public issue. Use a private security report through the repository’s GitHub security reporting channel.

## Quality gates

Run the composite check before opening a change:

```bash
pnpm check
```

Useful focused checks:

```bash
pnpm test
pnpm test:integration
pnpm verify:containers
pnpm check:templates
pnpm check:secrets
pnpm check:docs
```

The repository also runs these checks in GitHub Actions. The staging deployment workflow builds the three service images for `linux/amd64`, publishes immutable image digests, creates a Terraform plan, and applies only the approved plan for the configured staging environment.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Threat model](docs/architecture/threat-model.md)
- [Engineering principles](docs/architecture/engineering-principles.md)
- [Quality gates](docs/architecture/quality-gates.md)
- [Frontend architecture](docs/architecture/frontend.md)

## License

This project is licensed under the [MIT License](LICENSE).

## Project status

FalseRoute is an active engineering implementation. The local vertical slice, policy engine, event workflow, operator console, contracts, tests, and infrastructure definitions are present; production hardening and browser-level certification remain explicit work rather than implied guarantees.

If you are evaluating the project, start with the local quickstart and the [architecture overview](docs/architecture/overview.md). If you are changing a trust boundary, provider adapter, persistence rule, or deployment boundary, read the [engineering principles](docs/architecture/engineering-principles.md) and [quality gates](docs/architecture/quality-gates.md) first.

<div align="center">

Built for transparent security engineering: bounded authority, durable evidence, and no magic containment claims.

</div>
