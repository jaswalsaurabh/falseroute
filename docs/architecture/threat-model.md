# FalseRoute Threat Model

> **Status: Initial simulated scope approved; controlled autonomous foundation accepted; live activation pending**
> **Approved:** August 21, 2026
> **Last updated:** August 24, 2026

## Scope and Security Claim

This threat model covers the approved simulated intrusion-to-deception flow and the accepted controlled autonomous foundation described by ADR-0005. FalseRoute accepts a bounded synthetic scenario, persists and transports a versioned envelope, evaluates deterministic policy around Gemini tool requests, records every transition, and exposes persisted activity to an authenticated operator.

The release does **not** claim to contain a real attacker or protect a production network. Live mutation remains disabled because ADR-0005 activation evidence has not been recorded. Even after activation, authority is confined to dedicated demonstration resources, synthetic sources, bounded leases, and verified rollback.

Security controls evolve with each feature and trust-boundary change. OWASP ASVS 5.0 Level 2 is the target baseline for hosted Web and API surfaces, but neither that baseline nor this threat list is a claim to cover every known or future attack.

## Assets

- Integrity of intrusion events, policies, decisions, and audit records
- Availability of the API, worker, database, and dashboard
- Confidentiality of configuration, credentials, event data, logs, and telemetry
- Integrity of the action allowlist and deterministic policy engine
- Separation between the fictional decoy and any real environment

The simulated administrative portal and decoy credentials contain no real or production data.

## Actors

- **Simulated attacker:** Generates suspicious behavior through controlled test input.
- **Operator:** Reviews events and decisions in a controlled demonstration environment.
- **Developer:** Configures and runs the local or hosted demonstration.
- **External service:** Gemini receives a minimized event representation and returns structured enrichment.

## Trust Boundaries

1. **Event simulator to API:** All event fields are untrusted and require strict Zod validation, size limits, and rejection of unknown or malformed values.
2. **Operator browser to web/API:** Browser input and API responses cross a client/server boundary. The initial demonstration must run in a controlled environment until authentication is implemented.
3. **API and worker to PostgreSQL:** Only repository modules may access the database; all writes must preserve event and decision integrity.
4. **Worker to Gemini:** Event content leaves the application boundary. Only minimized, non-secret fields may be sent, and the response is untrusted.
5. **Application to logs and telemetry:** Structured records must redact secrets, credentials, and sensitive event fields.
6. **Decoy and tool adapters to Google Cloud:** Local and CI modes use fakes. An accepted live mode may reach only allowlisted resources in the dedicated demonstration project through separate least-privilege identities; no runtime path may reach production or third-party infrastructure.
7. **Pub/Sub to worker:** Push envelopes and OIDC identity are untrusted until issuer, audience, expiry, and service-account identity validate. Poison data is acknowledged only after durable quarantine ownership.
8. **Database activity log to SSE clients:** Persisted payloads remain untrusted and are recursively redacted for snapshots and streams. Resume and fanout must not invent completeness across an unverified gap.
9. **Operator to replay and emergency controls:** Ordinary read/write authentication does not authorize elevated replay or release. Reauthorization identity and rationale are audited.

## Gemini Safety Contract

Gemini may:

- Summarize bounded intrusion indicators
- Enrich the event with an explanation
- Recommend an action from an application-provided allowlist

Gemini may not:

- Execute commands or tools directly
- Select arbitrary URLs, hosts, routes, or infrastructure resources
- Override the deterministic decoy-credential policy
- Read secrets or production credentials
- Modify policies, authorization, network configuration, or database schemas

The application must validate model output against a strict schema and action allowlist. Invalid, missing, timed-out, or unsafe output is recorded as a degraded model result. It must never expand system authority or prevent the deterministic decoy-credential rule from producing its safe simulated decision.

## Initial Threats and Controls

| Threat                                            | Initial control                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed or oversized event input                | Strict Zod schemas, request limits, and rejection before persistence or processing                                                                                                                                                                                                                                                                                                                       |
| Prompt injection inside event fields              | Treat event content as data, use bounded prompts, require structured output, and enforce the action allowlist                                                                                                                                                                                                                                                                                            |
| Hallucinated or unauthorized action               | Deterministic policy validation; reject destinations or actions not defined by application code                                                                                                                                                                                                                                                                                                          |
| Secret or personal-data disclosure to Gemini      | Send only minimized fictional demonstration data; never include credentials or environment secrets                                                                                                                                                                                                                                                                                                       |
| Replay or duplicate events                        | Preserve event and correlation identifiers; define idempotency before public deployment                                                                                                                                                                                                                                                                                                                  |
| Tampered policy or decision data                  | Restrict writes to service/repository boundaries and create an audit record for every decision                                                                                                                                                                                                                                                                                                           |
| Sensitive data in logs or traces                  | Pino/OpenTelemetry redaction and explicit field allowlists before hosted deployment                                                                                                                                                                                                                                                                                                                      |
| Unauthenticated public access                     | Keep the initial demo controlled; authentication and authorization are required before production exposure                                                                                                                                                                                                                                                                                               |
| Decoy escape into real infrastructure             | The current release uses simulated mode, fictional data, a deterministic simulated agent adapter with no network or host-control capability, and database CHECK constraints. Any future live mode must pass ADR-0005 activation evidence and the dedicated-resource controls before it is enabled.                                                                                                       |
| Gemini unavailability                             | Record a degraded result and continue the deterministic safe path without retry storms                                                                                                                                                                                                                                                                                                                   |
| Unauthenticated AI spend or side-effect requests  | Require authentication, authorization, input-size limits, rate/concurrency budgets, and fail-closed production configuration before public exposure                                                                                                                                                                                                                                                      |
| Unsafe outbound URL or redirect behavior          | Route outbound HTTP through a hardened adapter that validates scheme, resolved address, every redirect, streaming size, and full-operation deadline                                                                                                                                                                                                                                                      |
| Cross-environment data exposure                   | Use separate credentials and data resources for development, test, staging, and production; never depend on naming conventions alone                                                                                                                                                                                                                                                                     |
| Misleading capability claims                      | Persist explicit `SIMULATED`, `PROPOSED`, `RECORDED`, or verified execution state and use matching truthful operator language (`"Simulated assignment recorded"`, `"RECORDED"`, `"No real traffic or infrastructure change occurred"`). Until live activation evidence exists, strictly prohibit claims such as `"Executed"`, `"Redirect succeeded"`, `"Attacker contained"`, or `"Traffic redirected"`. |
| Diagnostic information exposure                   | Keep public liveness minimal and protect metrics, readiness detail, queue state, and provider diagnostics by network policy or authorization                                                                                                                                                                                                                                                             |
| Volumetric or application-layer denial of service | Combine edge filtering and capacity controls with request-size limits, hierarchical rate limits, concurrency budgets, backpressure, and load shedding before database or provider work                                                                                                                                                                                                                   |
| Shared rate-limit exhaustion                      | Keep the service safety ceiling separate from per-principal and per-IP quotas so one actor cannot consume every client's allowance                                                                                                                                                                                                                                                                       |
| Distributed rate-limit inconsistency              | Label in-memory limits process-local; use atomic shared enforcement at the edge, gateway, or an approved distributed store before claiming cross-instance limits                                                                                                                                                                                                                                         |
| Credential stuffing or password guessing          | Apply per-account and per-source failure budgets, progressive delay where appropriate, generic responses, monitoring, and secure recovery without attacker-controlled lockout                                                                                                                                                                                                                            |
| Cross-site request forgery                        | When ambient browser credentials are introduced, require same-site cookie policy, origin validation, and anti-CSRF tokens where the chosen flow requires them                                                                                                                                                                                                                                            |
| Cross-site scripting and credential theft         | Encode untrusted output, avoid unsafe HTML execution, enforce browser security policy, and keep bearer credentials out of script-readable persistence where practical                                                                                                                                                                                                                                    |
| Container privilege escalation                    | Dedicated non-root user (`node`, UID 1000), read-only root filesystem compatibility, and no host volume mounts                                                                                                                                                                                                                                                                                           |
| Image credential or source leak                   | Multi-stage Docker builds, strict `.dockerignore` blocking `.git`, `.env*`, test databases, and private docs, and automated `scripts/verify-containers.ts` verification                                                                                                                                                                                                                                  |
| Premature connection dropping or unready traffic  | Immediate `503 SERVICE_UNAVAILABLE` signaling upon shutdown initiation, bounded connection draining against `SHUTDOWN_TIMEOUT_MS`, forced socket cleanup on timeout, and separate `/api/v1/health` and `/api/v1/ready` probes                                                                                                                                                                            |
| Inconsistent multi-instance quota enforcement     | Cloud Run single-instance constraint (`autoscaling.knative.dev/maxScale: "1"`) enforced mechanically by `scripts/validate-cloud-run-templates.ts` until distributed quota storage is introduced                                                                                                                                                                                                          |
| Direct secret injection into container specs      | Secret Manager references (`secretKeyRef`) required for all sensitive credentials (`DATABASE_URL`, `OPERATOR_ACCESS_TOKEN`, `GEMINI_API_KEY`); plain secret strings blocked by template validator                                                                                                                                                                                                        |
| Cascading dependency failure                      | Apply deadlines, bounded retries with jitter, concurrency isolation, backpressure, explicit degraded states, and fail-closed behavior for security-critical dependencies                                                                                                                                                                                                                                 |
| Retry amplification or provider cost exhaustion   | Bound retry attempts, total operation time, concurrency, per-principal work, and deployment-wide spend; never retry invalid or unauthorized work                                                                                                                                                                                                                                                         |
| Pub/Sub push spoofing or untrusted message intake | Validate OIDC service account token and expected audience at the push handler endpoint; reject unauthenticated deliveries with 401                                                                                                                                                                                                                                                                       |
| Poison-message retry storm in Pub/Sub             | Record schema-invalid messages in durable quarantine storage, publish once to quarantine topic, and acknowledge to release worker capacity; do not loop on unparseable payloads                                                                                                                                                                                                                          |
| Unauthorized DLQ replay or transport hijacking    | Require elevated operator reauthorization for DLQ replay; preserve original application and transport IDs while assigning an audited new transport ID                                                                                                                                                                                                                                                    |
| Gemini tool-request injection or argument bypass  | Parse and validate all tool arguments at the adapter boundary against shared Zod contracts; deterministic policy gateway authorizes, rewrites, or rejects every request before side-effect invocation                                                                                                                                                                                                    |
| Cloud Run Admin escalation or arbitrary container | Limit deployer identity to allowlisted template manifests with immutable image digests and resource constraints (`minScale=0, maxScale=1`); prohibit runtime selection of arbitrary projects, regions, or images                                                                                                                                                                                         |
| False-route gateway bypass or header spoofing     | Rely only on trusted-proxy-resolved client IP and route assignment records; ignore spoofable client forwarding headers; ensure API, health, readiness, and operator paths are never diverted                                                                                                                                                                                                             |
| Cloud Armor rule collision or broad CIDR outage   | Enforce policy fingerprint optimistic locking; restrict mutations to reserved priority range (1000–1999) and max 10 active rules; reject non-`/32` IPv4 and non-`/128` IPv6 sources and prohibit infrastructure, loopback, or private ranges                                                                                                                                                             |
| SSE token exposure or connection exhaustion       | Enforce Bearer token via `Authorization` header (never query parameters); bound concurrent SSE clients; enforce heartbeat interval, disconnect socket cleanup, and payload redaction                                                                                                                                                                                                                     |
| Provider-success / DB-write crash window          | Record provider intent in `ProviderIntentRecord` and `ToolOperationLedger` with application-generated idempotency keys before external calls; reconcile observed provider state before retrying                                                                                                                                                                                                          |
| Cleanup overlap or stale worker execution         | Implement transactional lease-sweep lock for Cloud Scheduler triggers; apply fencing tokens and version checks before updating lease or resource state                                                                                                                                                                                                                                                   |
| Denial of wallet via runaway cloud resources      | Enforce deployment concurrency caps (max 1 active decoy per event, max 3 concurrent across system), mandatory lease TTLs (default 300s, max 3600s), and automated orphan sweep                                                                                                                                                                                                                           |

## Rate-Limiting and Availability Policy

FalseRoute uses layered, hierarchical abuse controls rather than relying solely on global-only or endpoint-only limiting:

1. Edge infrastructure (when deployed) rejects volumetric traffic and enforces edge capacity ceilings before application resources are reached. Application rate limiting does not replace edge volumetric DDoS protection.
2. The API implements process-local in-memory token-bucket rate limiting before request-body parsing:
   - Evaluates authenticated principal identity when present, with a trusted-proxy-aware source IP fallback.
   - Enforces a secondary per-IP abuse boundary for unauthenticated or unverified principals to prevent principal spoofing across different IP origins.
   - Rejects quota violations with `HTTP 429 Too Many Requests` and explicit `Retry-After` headers.
3. A service-wide overload guard sheds excess in-flight requests under high local load with `HTTP 503 Service Unavailable` and `Retry-After`, distinctly separated from client quota rejections.
4. Request payload parsing (enforcing 64KB general / 8KB event limits) executes strictly after abuse filtering.
5. Outbound provider dependencies (Gemini) are bounded by process-local concurrency limits, execution deadlines, and bounded retries with jitter.

These controls are process-local in-memory safeguards per service instance. They do not constitute distributed rate limiting or cross-instance global guarantees. Atomic distributed enforcement (e.g., Redis-backed or gateway-level) is deferred to multi-instance/edge deployment.

## Dependency Failure Policy

- PostgreSQL is integrity-critical: writes and decisions fail closed when durable state cannot be verified. Readiness reports the dependency failure without exposing connection details.
- Gemini is optional enrichment: timeout, invalid output, or unavailability produces an explicit degraded result while deterministic application policy remains authoritative.
- An unavailable dashboard must not change stored policy decisions; an unavailable worker may delay processing but must not cause the API to claim completion.
- Failures must remain bounded by full-operation deadlines, concurrency limits, backpressure, and finite retry budgets. No service may create an unbounded retry or connection storm against another service.
- “Loosely coupled” means independently owned contracts and contained failure effects. It does not mean that every dependent capability remains available when its required dependency is down.

## Assumptions

- Initial events and identities are fictional and created for testing.
- Developers and operators control the demonstration environment.
- Google Cloud and Gemini credentials are supplied through secret management or local environment configuration and are never committed.
- Production authentication, tenant isolation, and real networking are not present in the initial vertical slice.

## Non-Goals

- Packet interception or traffic proxying outside the owned demonstration gateway
- Firewall, DNS, routing-table, IAM, or host modification
- Malware execution or analysis
- Active counterattacks or retaliation
- Engagement with real attackers
- A privileged host or network deception agent
- Production credential or customer-data processing
- Autonomous execution of unrestricted model-generated commands
- Multi-tenant isolation or complete incident-response automation

Any live action requires the accepted ADR-0005 boundary plus a completed activation record, named owners, isolation and failure evidence, and successful activation gates. Expanding beyond the dedicated demonstration project, owned gateway, allowlisted resources, or synthetic sources requires another threat-model revision and ADR.

Every accepted security finding must have an owner, target date, regression test, and closure evidence or documented risk acceptance. High-severity unresolved findings block hosted release.
