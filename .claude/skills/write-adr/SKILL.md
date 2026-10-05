---
name: write-adr
description: Template and process for recording an Architecture Decision Record in docs/adr/. Use when a design choice is made that future contributors would otherwise have to rediscover — a technology choice, a data-model rule, a cross-cutting convention, or reversing an earlier decision.
---

# Write an ADR

## When
Write one when someone later might reasonably ask "why is it done this way?" and the answer isn't obvious from the code. Typical cases: picking a technology or library, a rule that applies across modules, a trade-off that rejected an obvious alternative, or reversing an earlier ADR.

## Process
1. Next number: look at `docs/adr/` and take the highest `NNNN` plus 1.
2. Create `docs/adr/NNNN-kebab-case-title.md` from the template below.
3. Add a row to `docs/adr/README.md`.
4. If it changes the design, update the relevant section of `docs/architecture/HLD.md` or `LLD.md` in the same commit and link the ADR from there.
5. If it supersedes an earlier ADR, set the older one's Status to `Superseded by ADR-NNNN`. Don't change the rest of its text.

## Template
```markdown
# ADR-NNNN: <Decision as a short imperative>

**Status:** Proposed | Accepted (YYYY-MM-DD) | Superseded by ADR-NNNN

## Context
What problem or force makes a decision necessary now. Facts, constraints, and what goes wrong without a decision.

## Decision
What we will do, stated precisely enough to check code against it.

## Alternatives considered
- **<Option>:** why not, with concrete costs or risks.

## Consequences
What becomes easier, what becomes harder, follow-up work, and what would make us revisit this.
```

Keep it to about one screen. An ADR records a decision. It isn't a design document.
