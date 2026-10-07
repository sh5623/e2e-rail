# e2e-rail — working notes for agents

- Read `docs/superpowers/specs/2026-10-07-e2e-rail-design.md` first, then execute the two plan files in `docs/superpowers/plans/` task by task (part 1 → part 2). Each task is test-first and ends with a commit.
- Runtime dependencies stay at zero. `typescript` and `@playwright/test` are borrowed from the host repo via `createRequire`.
- Never narrow by guessing: when the selector cannot resolve a change, it widens to a full run. Code that "returns empty when unsure" is a bug.
- `--last-failed` is diagnostic. It is never reported or recorded as a full pass.
- Skills in `skills/` are canonical; `scripts/sync-codex.mjs` mirrors them into `plugins/e2e-rail/`. Tests assert the mirror is identical.
- Whole-tree staging flags are blocked by a user-level hook here. Stage files explicitly with `git add -- <paths>`.
