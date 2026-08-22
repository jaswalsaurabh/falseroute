# Initial Threat Model

> **Status: Approved for initial implementation**  
> **Approved:** August 21, 2026
> **Last updated:** August 22, 2026

## Scope and Security Claim

This threat model covers the first simulated intrusion-to-deception flow. FalseRoute accepts an event from a development simulator, evaluates one deterministic policy, uses Gemini for bounded enrichment and recommendation, records a simulated false-route decision, and displays the result.

The initial release does **not** claim to contain a real attacker or protect a production network. Its containment guarantee is limited to preventing model output and simulated attacker input from causing real network, host, or infrastructure changes.

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
6. **Simulated decoy to real systems:** No runtime path may connect the decoy or a generated action to production infrastructure.

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

| Threat                                            | Initial control                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed or oversized event input                | Strict Zod schemas, request limits, and rejection before persistence or processing                                                                                                                                                                                                                                                                                  |
| Prompt injection inside event fields              | Treat event content as data, use bounded prompts, require structured output, and enforce the action allowlist                                                                                                                                                                                                                                                       |
| Hallucinated or unauthorized action               | Deterministic policy validation; reject destinations or actions not defined by application code                                                                                                                                                                                                                                                                     |
| Secret or personal-data disclosure to Gemini      | Send only minimized fictional demonstration data; never include credentials or environment secrets                                                                                                                                                                                                                                                                  |
| Replay or duplicate events                        | Preserve event and correlation identifiers; define idempotency before public deployment                                                                                                                                                                                                                                                                             |
| Tampered policy or decision data                  | Restrict writes to service/repository boundaries and create an audit record for every decision                                                                                                                                                                                                                                                                      |
| Sensitive data in logs or traces                  | Pino/OpenTelemetry redaction and explicit field allowlists before hosted deployment                                                                                                                                                                                                                                                                                 |
| Unauthenticated public access                     | Keep the initial demo controlled; authentication and authorization are required before production exposure                                                                                                                                                                                                                                                          |
| Decoy escape into real infrastructure             | Simulated mode only, fictional data only, deterministic simulated agent adapter with no network or host-control capability, and database CHECK constraints                                                                                                                                                                                                          |
| Gemini unavailability                             | Record a degraded result and continue the deterministic safe path without retry storms                                                                                                                                                                                                                                                                              |
| Unauthenticated AI spend or side-effect requests  | Require authentication, authorization, input-size limits, rate/concurrency budgets, and fail-closed production configuration before public exposure                                                                                                                                                                                                                 |
| Unsafe outbound URL or redirect behavior          | Route outbound HTTP through a hardened adapter that validates scheme, resolved address, every redirect, streaming size, and full-operation deadline                                                                                                                                                                                                                 |
| Cross-environment data exposure                   | Use separate credentials and data resources for development, test, staging, and production; never depend on naming conventions alone                                                                                                                                                                                                                                |
| Misleading capability claims                      | Persist explicit `SIMULATED`, `PROPOSED`, `RECORDED`, or verified execution state and use matching truthful operator language (`"Simulated assignment recorded"`, `"RECORDED"`, `"No real traffic or infrastructure change occurred"`). Strictly prohibit misleading claims (`"Executed"`, `"Redirect succeeded"`, `"Attacker contained"`, `"Traffic redirected"`). |
| Diagnostic information exposure                   | Keep public liveness minimal and protect metrics, readiness detail, queue state, and provider diagnostics by network policy or authorization                                                                                                                                                                                                                        |
| Volumetric or application-layer denial of service | Combine edge filtering and capacity controls with request-size limits, hierarchical rate limits, concurrency budgets, backpressure, and load shedding before database or provider work                                                                                                                                                                              |
| Shared rate-limit exhaustion                      | Keep the service safety ceiling separate from per-principal and per-IP quotas so one actor cannot consume every client's allowance                                                                                                                                                                                                                                  |
| Distributed rate-limit inconsistency              | Label in-memory limits process-local; use atomic shared enforcement at the edge, gateway, or an approved distributed store before claiming cross-instance limits                                                                                                                                                                                                    |
| Credential stuffing or password guessing          | Apply per-account and per-source failure budgets, progressive delay where appropriate, generic responses, monitoring, and secure recovery without attacker-controlled lockout                                                                                                                                                                                       |
| Cross-site request forgery                        | When ambient browser credentials are introduced, require same-site cookie policy, origin validation, and anti-CSRF tokens where the chosen flow requires them                                                                                                                                                                                                       |
| Cross-site scripting and credential theft         | Encode untrusted output, avoid unsafe HTML execution, enforce browser security policy, and keep bearer credentials out of script-readable persistence where practical                                                                                                                                                                                               |
| Container privilege escalation                    | Dedicated non-root user (`node`, UID 1000), read-only root filesystem compatibility, and no host volume mounts                                                                                                                                                                                                                                                      |
| Image credential or source leak                   | Multi-stage Docker builds, strict `.dockerignore` blocking `.git`, `.env*`, test databases, and private docs, and automated `scripts/verify-containers.ts` verification                                                                                                                                                                                             |
| Premature connection dropping or unready traffic  | Immediate `503 SERVICE_UNAVAILABLE` signaling upon shutdown initiation, bounded connection draining against `SHUTDOWN_TIMEOUT_MS`, forced socket cleanup on timeout, and separate `/api/v1/health` and `/api/v1/ready` probes                                                                                                                                       |
| Inconsistent multi-instance quota enforcement     | Cloud Run single-instance constraint (`autoscaling.knative.dev/maxScale: "1"`) enforced mechanically by `scripts/validate-cloud-run-templates.ts` until distributed quota storage is introduced                                                                                                                                                                     |
| Direct secret injection into container specs      | Secret Manager references (`secretKeyRef`) required for all sensitive credentials (`DATABASE_URL`, `OPERATOR_ACCESS_TOKEN`, `GEMINI_API_KEY`); plain secret strings blocked by template validator                                                                                                                                                                   |
| Cascading dependency failure                      | Apply deadlines, bounded retries with jitter, concurrency isolation, backpressure, explicit degraded states, and fail-closed behavior for security-critical dependencies                                                                                                                                                                                            |
| Retry amplification or provider cost exhaustion   | Bound retry attempts, total operation time, concurrency, per-principal work, and deployment-wide spend; never retry invalid or unauthorized work                                                                                                                                                                                                                    |

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

- Live packet interception or traffic proxying
- Firewall, DNS, routing-table, IAM, or host modification
- Malware execution or analysis
- Active counterattacks or retaliation
- Engagement with real attackers
- A privileged host or network deception agent
- Production credential or customer-data processing
- Autonomous execution of unrestricted model-generated commands
- Multi-tenant isolation or complete incident-response automation

Any move from simulated containment to a real network action requires a new threat model, explicit authorization boundaries, isolation design, failure analysis, and a separate approved architecture decision.

Every accepted security finding must have an owner, target date, regression test, and closure evidence or documented risk acceptance. High-severity unresolved findings block hosted release.
