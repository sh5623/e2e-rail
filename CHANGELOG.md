# Changelog

## 0.1.0 — 2026-10-07

First release.

### CLI (`e2e-rail`, zero runtime dependencies, Node ≥ 20)

- `init` writes `e2e-rail.config.mjs` from the Playwright configs it finds, picks the tsconfig that holds `paths`
  (solution-style configs resolved to the referenced one), keeps only route-file globs that match, adds the ledger and
  Playwright output dirs to `.gitignore`, and suggests `package.json` scripts.
- `map` indexes exactly the test files Playwright lists, in the run env (routes, API mocks, imports, support helpers,
  projects) and, with `--check`, reports adapter and graph blind spots, tests outside `specDir`, a narrowing verdict
  and the unmapped share; `--explain <spec>` shows one spec.
- `select` turns a diff into a per-app selection with a reason per spec and widens to full whenever it cannot
  attribute a change (`no-base`, `shared`, `unknown-root`, `tier-full`, `support`, `app-other`, `spec-unindexed`,
  `adapter-unresolved`, `graph-unresolved`, `graph-shell`). `--add`/`--remove` amend it with a recorded reason;
  removal only after `shadow promote`. Exit 10 when any app runs in full.
- `run` wraps `playwright test` under a machine-wide heavy/light lock, rebuilds a stale preview dist, records one
  ledger line per run against a code fingerprint, refuses run-shaping options after `--`, marks `--project`/`--grep`
  runs `filtered` and selected runs in shadow mode `shadowed`, and returns Playwright's exit code; a test list that
  matches no test, or has a line that matches none, is recorded and returned as a failure (rc 1) although Playwright
  exits 0 there.
- `verify` answers from the ledger whether exactly this code passed (0 verified, 20 stale, 21 insufficient);
  `--require selected` counts only runs made by `run --selection`.
- `shadow record|status|promote|demote` pairs full runs with the selection for the same code and keeps a streak;
  promotion is a human decision.
- `measure slowest|retries|workers`, `shard plan|merge` (duration-balanced test lists bound to a hashed manifest, or
  native `--shard i/n`; a set verifies only when every shard of one split passed, and a complete merge moves
  last-green), and `lock status|reap|run`.

### Plugin layer

- Claude Code plugin: skills `init`, `select`, `gate`, `measure`, `shadow`; the read-only `e2e-impact-analyst`
  agent; a SessionStart hook injecting `hooks/doctrine.md`.
- Codex package in `plugins/e2e-rail/` (`.agents/plugins/marketplace.json`): the same skills, doctrine and the
  impact-analyst checklist as `references/impact-analyst.md`, mirrored by `npm run sync:codex`.
- CI templates: GitHub Actions shard matrix, CodeBuild batch build-graph, shadow-period buildspec snippet.
- README in English and Korean.

### Tests

- `npm test` runs the whole suite against a stub Playwright (`test/fixtures/sample-app`), with no network and no
  browser.
- `npm run test:contract` (opt-in, `E2E_RAIL_CONTRACT=1`) runs the real `@playwright/test` devDependency on a minimal
  app: `--list --reporter=json` paths and `config.rootDir`, the `--test-list` line format
  (`[project] › <path relative to rootDir>`), the JSON report fields the ledger parses, a ledger line that
  `verify --require selected` accepts, and that a wrong-base, empty or partly unmatched list fails the run. Its specs
  use no browser fixtures, so no browser download is needed.
