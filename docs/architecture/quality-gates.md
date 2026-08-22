# Repository Quality Gates

> **Status: Active engineering specification**  
> **Last verified:** August 22, 2026

This document defines the automated quality gates and activation schedule for FalseRoute. It implements the public requirements in the [Repository Engineering Principles](engineering-principles.md).

## Quality Gate Matrix

| Quality Gate                           | Enforcement Command                                    | Current Status | Activation Phase / Condition                    | Blocks Acceptance |
| -------------------------------------- | ------------------------------------------------------ | -------------- | ----------------------------------------------- | ----------------- |
| **Code Formatting**                    | `pnpm format:check`                                    | **Active**     | Phase 2 (All files)                             | Yes               |
| **Linting & Code Quality**             | `pnpm lint`                                            | **Active**     | Phase 2 (JS/TS/MJS)                             | Yes               |
| **Type Integrity**                     | `pnpm typecheck`                                       | **Active**     | Phase 2 (TypeScript 6 strict mode)              | Yes               |
| **Public Documentation Boundary**      | `pnpm check:docs`                                      | **Active**     | Phase 2 (Allowlist, links, Git ignore policy)   | Yes               |
| **Dependency & Catalog Policy**        | `pnpm check:dependencies`                              | **Active**     | Phase 2 (Exact versions, no pre-release)        | Yes               |
| **Source Review Bands & Placeholders** | `pnpm check:source-policy`                             | **Active**     | Phase 2 base; active on all first-party source  | Yes               |
| **Design Token Guardrails**            | `pnpm check:design-tokens`                             | **Active**     | Phase 2 base; evaluates 3-tier token hierarchy  | Yes               |
| **Pre-Commit Staged Guard**            | `pnpm precommit:check`                                 | **Active**     | Phase 2 (Husky 9 & lint-staged 17 hook)         | Yes               |
| **Secret & Credential Commit Guard**   | `pnpm check:secrets`                                   | **Active**     | Full tree in CI; staged files before commit     | Yes               |
| **Composite Quality Gate**             | `pnpm check`                                           | **Active**     | Root automated gate                             | Yes               |
| **Contract Schema Verification**       | `pnpm --filter @false-route/contracts test`            | **Active**     | Phase 3A (Zod contracts creation)               | Yes               |
| **Typed Configuration Validation**     | `pnpm --filter @false-route/config test`               | **Active**     | Phase 3A (Environment schemas creation)         | Yes               |
| **Foundation Builds & Unit Tests**     | `pnpm build && pnpm test`                              | **Active**     | All foundation packages & apps                  | Yes               |
| **Prisma Schema & Migrations**         | `pnpm --filter @false-route/database prisma:validate`  | **Active**     | Phase 3B (Database package creation)            | Yes               |
| **Database & Repositories**            | `pnpm --filter @false-route/database test:integration` | **Active**     | PostgreSQL integration tests                    | Yes               |
| **Observability & Log Redaction**      | `pnpm --filter @false-route/observability test`        | **Active**     | Secret and credential redaction                 | Yes               |
| **Constant-Time Token Verification**   | `pnpm --filter @false-route/security test`             | **Active**     | Operator token verification                     | Yes               |
| **API Application & Routes**           | `pnpm --filter @false-route/api test`                  | **Active**     | Express 5 API unit & integration                | Yes               |
| **Worker Service & Policy Engine**     | `pnpm --filter @false-route/worker test`               | **Active**     | Worker orchestration & policy determinism       | Yes               |
| **Web Dashboard & Component States**   | `pnpm --filter @false-route/web test`                  | **Active**     | React component & session state tests           | Yes               |
| **System Integration Pipeline**        | `pnpm test:integration`                                | **Active**     | Full API -> DB -> Worker -> API integration     | Yes               |
| **CI Automation Quality Gates**        | `.github/workflows/ci.yml`                             | **Active**     | GitHub Actions automated validation             | Yes               |
| **Browser End-to-End Suite**           | `pnpm --filter @false-route/e2e test`                  | **Deferred**   | Local backlog (reconsider before public deploy) | No                |

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
  - Enforces three-tier design token hierarchy across all Web and UI source files (`apps/web/src`, `packages/ui/src`).
  - Prohibits raw hexadecimal and RGB/HSL color literals outside token definition files.
  - Prohibits direct primitive token consumption in component code where semantic tokens are required.

### 8. Composite Check

- **Command:** `pnpm check`
- **Scope:** Runs `format:check`, `lint`, `typecheck`, `build`, `test`, and `check:repo` in sequence.

### 9. Pre-Commit Staged Guard

- **Hook:** `.husky/pre-commit` (installed via `prepare: husky`)
- **Command:** `pnpm precommit:check` (runs `lint-staged`, `check:docs`, `guard:credentials`, and `guard:prisma`)
- **Configuration:** `lint-staged.config.ts`
- **Actions Executed on Staged Changes:**
  1. Formats staged files with Prettier (`--write --ignore-unknown`) and automatically re-stages them.
  2. Runs Oxlint (`--deny-warnings`) against staged JavaScript and TypeScript files.
  3. Validates public documentation boundaries and markdown links (`pnpm check:docs`).
  4. Scans staged changes for committed credentials and secrets (`pnpm guard:credentials`).
  5. Validates Prisma schema syntax and relations (`pnpm guard:prisma`).
- **Boundary & CI Separation:** Pre-commit provides fast feedback during local development and intentionally avoids heavy operations (whole-repository typechecking, builds, unit tests, and integration test suites). Because developer hooks can be bypassed locally, secret scanning (`pnpm check:secrets`) and Prisma validation/migrations (`pnpm guard:prisma` and `migrate:deploy`) are independently executed and strictly enforced across the complete repository tree in CI.

### 10. Secret & Credential Commit Guard

- **Commands:** `pnpm check:secrets` and `pnpm check:secrets:staged`
- **Scripts:** `scripts/check-secrets.ts`, `scripts/secret-scanner.ts`, and `.husky/pre-commit`
- **Rules Enforced:**
  - Rejects private environment files, private keys, keystores, provider-shaped access tokens, JSON Web Tokens, credential-bearing URLs, and probable hard-coded credentials.
  - Scans test files and examples; explicit `dummy`, `not-a-real`, `example`, and equivalent placeholder markers remain permitted.
  - Reports only location and finding category, never the matched credential value.
  - Runs against staged content through the installed Git hook and against the repository tree in CI.

### 11. Contract Schema Verification

- **Command:** `pnpm --filter @false-route/contracts test`
- **Scope:** Validates all Zod contract schemas, bounds, strict properties, enums, and provenance distinctions.

### 12. Typed Configuration Validation

- **Command:** `pnpm --filter @false-route/config test`
- **Scope:** Validates environment variable parsing, default coercion, immutability, and safe secret-free error output.

### 13. Prisma Schema & Migrations Validation

- **Command:** `pnpm --filter @false-route/database prisma:validate`
- **Scope:** Validates Prisma 7 schema syntax, relational integrity, and migration configuration through `scripts/prisma-guard.ts`.
- **Safety Policy:** Blocks reset and direct database commands, prohibits data-loss flags, and permits development migrations only with `--create-only`.

---

## Deferred Quality Gates

The following quality gates remain deferred in the local backlog and will be activated when corresponding production infrastructure or tooling is introduced:

- **Browser End-to-End Playwright Scenarios:** Browser automation verifying intrusion simulation across the Web UI in staging.
- **Container Build & Non-Root User Verification:** Automated validation of container image security and non-root execution.
- **Outbound HTTP Security Checks:** Enforcement of scheme policy, DNS/IP validation, and streaming byte limits for outbound HTTP adapters.
