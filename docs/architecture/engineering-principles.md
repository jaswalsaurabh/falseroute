# Repository Engineering Principles

> **Status: Approved for implementation**  
> **Approved:** August 21, 2026

## Guiding Principle

FalseRoute may solve a complex problem, but its business logic, code, architecture, and repository must remain simple to navigate and easy to explain. Complexity must be isolated behind explicit boundaries rather than spread across files, layers, or abstractions.

These rules apply to every application, package, script, test, infrastructure module, and agent contribution in the repository.

## Simplicity Before Abstraction

- Prefer the smallest design that clearly satisfies the approved use case.
- Keep control flow explicit. Avoid hidden side effects, implicit global state, metaprogramming, and unnecessary indirection.
- Introduce an abstraction only when it gives a clear boundary, enforces an invariant, or serves multiple concrete consumers.
- Do not create speculative helpers, base classes, packages, layers, or generic frameworks for imagined future requirements.
- Optimize first for correctness and readability, then for reuse and performance when evidence justifies it.
- A reviewer should be able to trace a use case from its entry point to its decision and persistence boundaries without searching unrelated modules.

## Responsibility and Reuse

- Apply the Single Responsibility Principle to modules, functions, classes, components, services, and packages.
- Keep business rules independent of HTTP, UI, database, model-provider, and framework details wherever practical.
- Reuse stable behavior and components, not accidental similarity.
- Follow DRY when duplicated knowledge or behavior could diverge. Do not remove harmless local repetition by creating a harder-to-understand abstraction.
- Promote code to a shared package or shared UI layer only after at least two real consumers need the same stable contract or behavior.
- Prefer composition over inheritance.
- Keep public APIs narrow and make dependency direction explicit.

## Repository Boundaries

- Applications own deployment entry points and application composition.
- Shared packages own reusable contracts or capabilities, not application-specific workflows.
- A package must not reach into another package's private source files.
- Avoid circular dependencies and bidirectional feature dependencies.
- Cross-boundary communication uses typed public contracts.
- Tests live beside the behavior they verify; root end-to-end tests cover cross-application flows only.

## Backend and Server Architecture

Server-side request flow follows this direction:

```text
route -> middleware -> controller -> service/use case -> repository or integration
```

- **Routes** declare endpoints and compose the request pipeline. They contain no business logic.
- **Middleware** handles request-scoped cross-cutting concerns such as correlation IDs, authentication, authorization, validation, rate limits, and error translation. Middleware must not become a hidden business workflow.
- **Controllers** translate validated transport input into a service call and translate the result into an HTTP response.
- **Services/use cases** own orchestration and business decisions. They do not depend on Express request or response objects.
- **Domain modules** contain pure rules and invariants where a rule can be expressed independently of orchestration.
- **Repositories** own persistence operations and expose intention-revealing interfaces rather than leaking Prisma throughout the application.
- **Integrations/adapters** isolate Gemini, Google Cloud, and other external providers behind internal interfaces.

The Worker follows the same separation: entry point -> processor/orchestrator -> service/use case -> repository or integration. Background processing is not permission to mix model calls, policy logic, persistence, and telemetry in one module.

## Error and Side-Effect Boundaries

- Validate untrusted data at the boundary and keep validated types inside the system.
- Make database writes, network calls, model calls, and other side effects visible and injectable.
- Use typed domain or application errors and translate them once at the outer boundary.
- Do not catch errors merely to log and rethrow them repeatedly.
- Preserve correlation and audit context across layers without passing framework objects into business logic.

## Truth, Evidence, and Provider Boundaries

- Distinguish observed facts, derived values, model inferences, operator decisions, and unavailable information in types and persistence.
- Preserve provenance, observation time, model/rule version, and confidence or sufficient-sample state where applicable.
- Give every derived decision one deterministic owner. Caches, search documents, and UI views are projections, not independent sources of truth.
- Decode external and Gemini responses at the adapter boundary. Never cast unchecked provider JSON into a trusted domain type.
- Never describe an output as grounded, verified, contained, redirected, or executed unless code validates or performs that exact claim.
- Business constants and ranges have one executable owner plus boundary tests; do not duplicate them in documentation or presentation code.

## Security and Operational Closure

- Security findings require severity, owner, target date, regression coverage, and closure evidence or explicit risk acceptance.
- Protect every external cost or side-effect boundary with authentication, authorization, input/size limits, rate/concurrency budgets, and fail-closed production configuration.
- Centralize outbound HTTP and enforce URL scheme, address, redirect, timeout, response-size, and concurrency policy.
- Run containers as non-root by default and isolate development, test, staging, and production data and credentials.
- Describe queue and idempotency semantics honestly. Do not claim exactly-once without an atomic durable proof for the named side effect.
- A demo-safe in-memory mechanism must be labeled process-local and must not be presented as horizontally scalable or restart-safe.

## Quality Gates

- A mandatory rule includes an enforcement mechanism or an explicitly tracked plan to add one when the relevant code exists (see [Quality Gates](quality-gates.md) for the active matrix).
- Executable packages provide consistent formatting, lint, type-check, test, and build scripts as applicable.
- CI uses a frozen lockfile and runs the complete required quality graph; missing workspace scripts must not silently skip required checks.
- E2E setup uses isolated resources and verifies product identity before executing scenarios.
- Test positive behavior, negative controls, insufficient evidence, provider failure, authorization, concurrency, and duplicate delivery where those risks exist.
- Metrics require a real update site, owner, intended dashboard or alert, and instrumentation verification.

## Public Documentation Boundary

- Markdown is internal by default. Public Markdown is limited to the root `README.md` and explicitly approved architecture documents.
- Public documentation must not contain secrets, credentials, personal or local filesystem paths, private project identifiers, private commit references, internal audit evidence, or non-public operational details.
- Public links must resolve using only files included in the public repository.
- Adding a public Markdown file requires an explicit `.gitignore` allowlist entry and documentation-gate coverage.

## Commenting Standard

Code should explain **what** it does through names, types, structure, and tests. Comments are reserved for information the code cannot express clearly.

Add a comment when it explains:

- Why a non-obvious decision or trade-off exists
- A security boundary, invariant, or failure-mode constraint
- An external API, browser, compiler, or infrastructure quirk
- A deliberately unusual algorithm or performance choice
- A temporary workaround with a clear removal condition or tracking reference

Do not add comments that:

- Restate the next line of code
- Narrate straightforward control flow
- Preserve deleted or commented-out code
- Compensate for unclear naming or an oversized function
- Describe behavior likely to become stale when tests or types can express it

Public API documentation should describe contracts, constraints, and observable behavior rather than implementation steps.

## Source-of-Truth and Search Rule

Before introducing a pattern, dependency, name, or architecture decision:

1. Read the applicable repository instructions available in the development environment.
2. Search the repository with `rg` or the available code/content search tool for an existing solution.
3. Check the public architecture documents and any approved internal plan, terminology, or decision record available for the change.
4. Check the internal engineering guidance for previously identified failure patterns.
5. Consult official upstream documentation when behavior is version-specific or the repository does not answer the question.
6. Add or supersede an ADR when a consequential decision changes.

Do not copy an external rule blindly. Repository decisions and approved security boundaries remain authoritative unless explicitly superseded.

## Review Checklist

- Is the business rule easy to locate and test?
- Does each module have one clear reason to change?
- Are transport, business logic, persistence, and external integrations separated?
- Is reuse supported by real consumers rather than speculation?
- Are names and types doing work that unnecessary comments would otherwise do?
- Are new dependencies and abstractions justified?
- Are security constraints and failure modes preserved?
- Are claims, provenance, uncertainty, and side-effect semantics honest?
- Is every mandatory new rule enforceable or paired with an enforcement plan?
- Can a new contributor trace the change without hidden context?
