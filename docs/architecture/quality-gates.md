# Repository Quality Gates

> **Status: Active engineering specification**  
> **Last verified:** August 21, 2026

This document defines the automated quality gates and activation schedule for FalseRoute. It implements the public requirements in the [Repository Engineering Principles](engineering-principles.md).

## Quality Gate Matrix

| Quality Gate                           | Enforcement Command                                   | Current Status          | Activation Phase / Condition                   | Blocks Acceptance |
| -------------------------------------- | ----------------------------------------------------- | ----------------------- | ---------------------------------------------- | ----------------- |
| **Code Formatting**                    | `pnpm format:check`                                   | **Active**              | Phase 2 (All files)                            | Yes               |
| **Linting & Code Quality**             | `pnpm lint`                                           | **Active**              | Phase 2 (JS/TS/MJS)                            | Yes               |
| **Type Integrity**                     | `pnpm typecheck`                                      | **Active**              | Phase 2 (TypeScript 6 strict mode)             | Yes               |
| **Public Documentation Boundary**      | `pnpm check:docs`                                     | **Active**              | Phase 2 (Allowlist, links, Git ignore policy)  | Yes               |
| **Dependency & Catalog Policy**        | `pnpm check:dependencies`                             | **Active**              | Phase 2 (Exact versions, no pre-release)       | Yes               |
| **Source Review Bands & Placeholders** | `pnpm check:source-policy`                            | **Active**              | Phase 2 base; active on all first-party source | Yes               |
| **Design Token Guardrails**            | `pnpm check:design-tokens`                            | **Active** (Clean skip) | Phase 2 base; evaluates on Web UI creation     | Yes               |
| **Composite Quality Gate**             | `pnpm check`                                          | **Active**              | Phase 2 base; updated for Phase 3A             | Yes               |
| **Contract Schema Verification**       | `pnpm --filter @false-route/contracts test`           | **Active**              | Phase 3A (Zod contracts creation)              | Yes               |
| **Typed Configuration Validation**     | `pnpm --filter @false-route/config test`              | **Active**              | Phase 3A (Environment schemas creation)        | Yes               |
| **Foundation Builds & Unit Tests**     | `pnpm build && pnpm test`                             | **Active**              | Phase 3A (Shared foundation packages)          | Yes               |
| **Prisma Schema & Migrations**         | `pnpm --filter @false-route/database prisma validate` | **Deferred**            | Phase 3B (Database package creation)           | Yes               |
| **Application Unit & Integration**     | `pnpm test` (apps/* suites)                           | **Deferred**            | Phase 4 (Application services creation)        | Yes               |
| **Browser End-to-End Suite**           | `pnpm --filter @false-route/e2e test`                 | **Deferred**            | Phase 4 (Web dashboard & vertical slice)       | Yes               |
| **Deterministic AI Replay Harness**    | `pnpm --filter @false-route/worker test:replay`       | **Deferred**            | Phase 4 (Gemini adapter creation)              | Yes               |
| **CI Automation & Container Scans**    | `.github/workflows/ci.yml`                            | **Deferred**            | Phase 5 (Production hardening)                 | Yes               |
| **Outbound HTTP & SSRF Hardening**     | `pnpm test:security`                                  | **Deferred**            | Phase 5 (Security boundaries)                  | Yes               |

---

## Active Phase 2 Checks

### 1. Code Formatting

- **Command:** `pnpm format:check` (Fix: `pnpm format`)
- **Tool:** Prettier 3.9.6
- **Scope:** All tracked repository files excluding ignored build/cache artifacts.
- **Rule:** Zero unformatted files permitted.

### 2. Code Quality & Linting

- **Command:** `pnpm lint` (`oxlint --deny-warnings`)
- **Tool:** Oxlint 1.79.0
- **Scope:** Root scripts, configuration files, and all workspace packages.
- **Rule:** High-signal correctness, suspicious, performance, TypeScript, import, and Node.js rules enabled; `@typescript-eslint/no-explicit-any` and unused variables enforced; type-aware linting deferred until TypeScript 7.

### 3. Type Checking

- **Command:** `pnpm typecheck`
- **Tool:** TypeScript 6.0.2 compiler (`tsc --noEmit`)
- **Scope:** Root configuration and shared TypeScript configurations.
- **Rule:** Strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `verbatimModuleSyntax`.

### 4. Public Documentation Boundary

- **Command:** `pnpm check:docs`
- **Script:** [scripts/check-docs.mjs](../../scripts/check-docs.mjs)
- **Rules Enforced:**
  - `README.md` and approved public architecture documents exist and are not ignored.
  - Local links in public Markdown resolve to public files.
  - Every other Markdown file is ignored by Git unless it is explicitly approved and added to the public allowlist.

### 5. Dependency & Catalog Policy

- **Command:** `pnpm check:dependencies`
- **Script:** [scripts/check-dependencies.mjs](../../scripts/check-dependencies.mjs)
- **Rules Enforced:**
  - Direct dependencies must be exact versions or reference `catalog:`.
  - Prohibits pre-release dependency versions (alpha, beta, rc, next, canary, dev, preview).
  - Enforces version agreement across `packageManager`, `engines.pnpm`, `engines.node`, `.nvmrc`, and `pnpm-workspace.yaml`.
  - Prohibits unapproved version drift across workspace manifests.

### 6. Source Review Bands & Prohibited Placeholders

- **Command:** `pnpm check:source-policy`
- **Script:** [scripts/check-source-policy.mjs](../../scripts/check-source-policy.mjs)
- **Rules Enforced:**
  - Evaluates all first-party source files across `apps/*`, `packages/*`, and `tests/*`.
  - First-party source files approaching 300 lines trigger a review warning.
  - First-party source files exceeding 500 lines trigger a build failure unless explicitly allowlisted with documented justification.
  - Prohibits untracked placeholder product values or unreferenced `TODO`/`FIXME`/`HACK` markers in production source files.
  - Prohibits duplicate contract declarations matching canonical `@false-route/contracts` export names via AST inspection (renamed structural duplication remains a manual review concern).

### 7. Design Token Guardrails

- **Command:** `pnpm check:design-tokens`
- **Script:** [scripts/check-design-tokens.mjs](../../scripts/check-design-tokens.mjs)
- **Rules Enforced:**
  - Clean skip during Phase 2 while Web UI directories are unpopulated.
  - Prohibits raw hexadecimal and RGB/HSL color literals outside token definition files.
  - Prohibits direct primitive token consumption in component code where semantic tokens are required.

### 8. Composite Check

- **Command:** `pnpm check`
- **Scope:** Runs `format:check`, `lint`, `typecheck`, `build`, `test`, and `check:repo` in sequence.

### 9. Contract Schema Verification

- **Command:** `pnpm --filter @false-route/contracts test`
- **Scope:** Validates all Zod contract schemas, bounds, strict properties, enums, and provenance distinctions.

### 10. Typed Configuration Validation

- **Command:** `pnpm --filter @false-route/config test`
- **Scope:** Validates environment variable parsing, default coercion, immutability, and safe secret-free error output.

---

## Deferred Quality Gates

### Phase 3B: Database Foundation

- **Prisma Schema Validation:** Validates `packages/database/prisma/schema.prisma` syntax and migration alignment.

### Phase 4: Vertical Slice

- **Vitest Unit & Integration Suites:** Validates policy engine determinism, API request validation, and worker processing.
- **Playwright End-to-End Scenarios:** Verifies the full intrusion event intake, worker evaluation, and Web dashboard display flow with product identity verification.
- **Gemini Adapter Replay & Fallback Tests:** Verifies bounded model authority, schema parsing, and degraded fallback handling.

### Phase 5: Production Hardening

- **GitHub Actions CI Quality Gates:** Automated execution of the full quality gate matrix on pull requests and branch pushes.
- **Container Build & User Verification:** Validates Docker builds run as non-root users.
- **Outbound HTTP Security Checks:** Enforces URL schemes, resolved IP ranges, streaming byte limits, and redirect constraints.
