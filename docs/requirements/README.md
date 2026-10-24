# Requirements

This area defines **what must be true** of `system`. Requirements are normative.
They say nothing about mechanisms (see [design](../design/README.md)) or about why
a choice was made (see [decisions](../decisions/README.md)).

> Target state: until [PROP-0001](../proposals/0001-unified-system-architecture.md)
> is implemented, these requirements describe the system being built.

## Documents

| Document | Owns |
|---|---|
| [purpose.md](purpose.md) | why `system` exists: the four purposes (P1–P4) that every requirement traces to |
| [release-scope.md](release-scope.md) | what MVP, Beta, Base, and production-ready must each deliver, with exit criteria |
| [SRS.md](SRS.md) | functional requirements, as `REQ-<family>-<n>` ids |
| [quality-attributes.md](quality-attributes.md) | non-functional qualities (`QA-<n>`) |
| [constraints.md](constraints.md) | platform, legal, and environment constraints (`CON-<n>`) |

## Rules

- Requirement ids are stable. A retired requirement keeps its id and text, marked
  `*(retired <date>, <PROP or ADR>: <why>)*` after the id. It needs no test, no
  test may cite it (`pnpm check:traceability` fails), and its id is never reused.
- Each requirement must be verifiable. When code exists, the test or validation
  evidence links back to the id.
