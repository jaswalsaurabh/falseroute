# Initial Threat Model

> **Status: Approved for initial implementation**  
> **Approved:** August 21, 2026

## Scope and Security Claim

This threat model covers the first simulated intrusion-to-deception flow. FalseRoute accepts an event from a development simulator, evaluates one deterministic policy, uses Gemini for bounded enrichment and recommendation, records a simulated false-route decision, and displays the result.

The initial release does **not** claim to contain a real attacker or protect a production network. Its containment guarantee is limited to preventing model output and simulated attacker input from causing real network, host, or infrastructure changes.

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

| Threat                                           | Initial control                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed or oversized event input               | Strict Zod schemas, request limits, and rejection before persistence or processing                                                                  |
| Prompt injection inside event fields             | Treat event content as data, use bounded prompts, require structured output, and enforce the action allowlist                                       |
| Hallucinated or unauthorized action              | Deterministic policy validation; reject destinations or actions not defined by application code                                                     |
| Secret or personal-data disclosure to Gemini     | Send only minimized fictional demonstration data; never include credentials or environment secrets                                                  |
| Replay or duplicate events                       | Preserve event and correlation identifiers; define idempotency before public deployment                                                             |
| Tampered policy or decision data                 | Restrict writes to service/repository boundaries and create an audit record for every decision                                                      |
| Sensitive data in logs or traces                 | Pino/OpenTelemetry redaction and explicit field allowlists before hosted deployment                                                                 |
| Unauthenticated public access                    | Keep the initial demo controlled; authentication and authorization are required before production exposure                                          |
| Decoy escape into real infrastructure            | Simulated mode only, fictional data only, and no network or host-control capability                                                                 |
| Gemini unavailability                            | Record a degraded result and continue the deterministic safe path without retry storms                                                              |
| Unauthenticated AI spend or side-effect requests | Require authentication, authorization, input-size limits, rate/concurrency budgets, and fail-closed production configuration before public exposure |
| Unsafe outbound URL or redirect behavior         | Route outbound HTTP through a hardened adapter that validates scheme, resolved address, every redirect, streaming size, and full-operation deadline |
| Cross-environment data exposure                  | Use separate credentials and data resources for development, test, staging, and production; never depend on naming conventions alone                |
| Misleading capability claims                     | Persist explicit `SIMULATED`, `PROPOSED`, `RECORDED`, or verified execution state and use matching operator language                                |
| Diagnostic information exposure                  | Keep public liveness minimal and protect metrics, readiness detail, queue state, and provider diagnostics by network policy or authorization        |

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
