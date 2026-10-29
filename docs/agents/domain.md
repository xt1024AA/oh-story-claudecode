# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: multi-context

This repo is a **multi-context** repo: the root `CONTEXT-MAP.md` is the single index and points at one `CONTEXT.md` per subproject. Read the subproject glossary that matches the area you are about to touch, not the whole set.

Neither file exists yet. That is expected — they are created lazily the first time a term or a decision actually gets resolved, at which point the root `CONTEXT-MAP.md` is the file that gains the pointer to the new subproject's `CONTEXT.md`.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root, if it exists: follow the pointers and read each `CONTEXT.md` relevant to the topic.
- **`CONTEXT.md`** at a subproject root, when you are inside that subproject.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `<subproject>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md                        ← single index, one pointer per subproject
├── docs/adr/                             ← system-wide decisions
├── skills/
│   └── <subproject>/
│       ├── CONTEXT.md
│       └── docs/adr/                     ← subproject-specific decisions
└── scripts/
```

Single-context repos (the absence of a root `CONTEXT-MAP.md`) keep the simpler shape instead:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
