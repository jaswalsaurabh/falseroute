# Frontend Architecture and Design System

> **Status: Approved for implementation**  
> **Approved:** August 21, 2026

The Web application must remain understandable as its UI grows. It uses reusable components, a three-tier tokenized design system, accessible interaction patterns, and feature-oriented organization only when product complexity justifies it.

## Three-Tier Tokenized Design System

### Tier 1: Primitive Tokens

Primitive tokens are context-free design values such as color scales, spacing steps, typography scales, radii, shadows, breakpoints, z-index levels, and motion durations. They are the raw vocabulary of the system and should not be used directly throughout feature UI.

Examples: `color.blue.600`, `space.4`, `font.size.sm`, and `radius.md`.

### Tier 2: Semantic Tokens

Semantic tokens describe purpose and state. They map primitive values to meanings that remain stable across themes and visual revisions.

Examples: `surface.default`, `text.muted`, `border.danger`, `action.primary`, `status.warning`, and `focus.ring`.

Application UI should normally consume semantic tokens instead of raw colors or measurements. Theme, contrast, and dark-mode changes belong at this tier.

### Tier 3: Component Tokens

Component tokens capture deliberate variations for reusable components when semantic tokens alone are insufficient.

Examples: `button.primary.background`, `table.header.text`, and `eventCard.critical.border`.

Component tokens must derive from semantic tokens (following the primitive -> semantic -> component token chain) and must not create a second disconnected visual system. Add them only for a real reusable component need.

## Token Rules

- Avoid unexplained hard-coded colors, spacing, typography, radii, shadows, and motion values in feature code.
- Name tokens by role and intent, not by a value that may change.
- Maintain accessible color contrast and visible focus states as token-level requirements.
- Respect reduced-motion preferences and keep motion purposeful.
- Do not encode business state only through color; pair it with text, icons, or other accessible indicators.
- Keep responsive behavior and density deliberate rather than adding arbitrary one-off breakpoints.
- Enforce the token boundary with lint rules: raw colors and direct primitive-token use are allowed only in token definition files.
- Add automated theme-completeness, contrast, and reduced-motion checks as the token surface grows.

## Card Grammar

FalseRoute cards share a common structural treatment, but directional color accents are reserved for
meaningful hierarchy and state. Do not add an accent merely to make a card more visually prominent.

| Card role   | Treatment                                                       | Use for                                                                                      |
| ----------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Base card   | Neutral surface, subtle border, shared radius and elevation     | Ordinary metrics, summaries, and supporting content                                          |
| Layer card  | Base card with a semantic top accent                            | Major product layers such as Telemetry, Orchestrator, Containment, and Decision intelligence |
| State card  | Base card with a semantic left accent                           | Live event severity, degraded state, warnings, failures, or other status-bearing content     |
| Metric card | Base card with no directional accent; emphasize value and label | Aggregate counts and operational summaries                                                   |
| Alert card  | State treatment plus explicit status text and icon              | Operator attention, unavailable data, and failure messages                                   |

Top accents identify what a section is. Left accents identify what state a piece of content is in.
They are complementary patterns and should not be applied together unless the component has both
responsibilities. Telemetry event rows retain left accents for event state; their parent workspace
section may use a top accent for the Telemetry layer. Neutral cards remain the default for content
without a distinct layer or state. All variants must consume semantic tokens and preserve text or
icon labels so color is never the only state signal.

## Component Layers

1. **UI primitives:** Small accessible elements such as Button, Input, Badge, Dialog, and Table foundations.
2. **Shared composed components:** Stable combinations needed by at least two features, such as status displays or event metadata.
3. **Feature components:** Components that express one product workflow and remain inside that feature unless reuse becomes real.
4. **Pages/routes:** Composition and data-loading boundaries. Pages do not become stores for reusable business logic.

Components should have focused APIs, clear state ownership, keyboard support, and tests proportional to their behavior. Prefer composition over a single component with many unrelated modes and Boolean props.

Shared interactive primitives should have stories or an equivalent isolated review surface when they gain meaningful variants or states. Stories complement behavior and accessibility tests; they do not replace them.

## Feature Architecture

Start with the simplest local organization. Introduce `features/<feature-name>/` when a product area has a coherent workflow and at least one of these signals appears:

- It spans multiple routes or substantial UI states.
- It owns related API access, validation, state, components, and tests.
- Changes repeatedly touch a recognizable set of files.
- A flat component structure makes ownership or dependency direction unclear.

A feature may contain only the folders it actually needs, for example:

```text
features/intrusion-events/
├── api/
├── components/
├── hooks/
├── schemas/
├── state/
└── tests/
```

Do not generate every folder by default. Feature code may depend on shared UI and contracts; shared code must not depend on a feature. Features must not import another feature's private internals. A small explicit public entry point may expose genuinely shared feature capabilities.

## State and Business Logic

- Keep server state, URL state, form state, and local presentation state distinct.
- Put domain and policy logic in shared domain/application modules, not React components or hooks.
- Keep API transport details behind typed feature or shared clients.
- Derive state instead of synchronizing duplicate copies.
- Avoid global state until multiple distant consumers have a concrete coordination need.
- Treat loading, empty, error, partial, stale, and unauthorized states as first-class UI behavior.

## Accessibility and Content

- Prefer semantic HTML and native interaction behavior before custom widgets.
- Every interactive control must be keyboard accessible with a visible focus indicator.
- Inputs require programmatic labels and errors must be associated with the relevant field.
- Dynamic status changes should be announced appropriately without excessive interruption.
- Interface text should use the approved terminology and explain decisions in operator language.
- The dashboard must not expose secrets or unredacted sensitive event data.

## Frontend Review Checklist

- Does the UI use the three token tiers without arbitrary values?
- Is the component reusable for a real reason and responsible for one concern?
- Is feature architecture justified by current complexity?
- Is business logic outside presentation components?
- Are all states, keyboard behavior, focus, contrast, and reduced motion handled?
- Does the UI use approved FalseRoute terminology and redaction rules?
- Do E2E tests verify they started the correct product and build before exercising the UI?
