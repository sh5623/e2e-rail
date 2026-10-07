# Changelog

## 0.2.0 — 2026-10-08

Fixes from an external audit (each P1 reproduced with real Playwright 1.63). The invariant they restore: a run is
never presented as a verification it is not, and nothing narrows by guessing.

### Breaking

- `@playwright/test` ≥ 1.56 (peer dependency; was ≥ 1.44). Selected and shard runs use `--test-list`, which
  Playwright has from 1.56.0. `run`, `map`, `select` and `shard plan` refuse an older one:
  `@playwright/test 1.56.0 or newer is required (found <x>): selected and shard runs use --test-list`.
- Arguments after `--` are classified by an allow-list. Only `--headed`, `--quiet`, `--trace <mode>`,
  `--repeat-each <n>`, `--fail-on-flaky-tests`, `--forbid-only`, `--fully-parallel`, `--max-failures <n>`, `-x` and
  `-j`/`--workers <n>` leave a run what its kind says; every other argument, an unknown one included, makes it
  `filtered`. A run that passed `--retries`, `--timeout` or `-u` used to verify and no longer does. `--ui`, `--debug`,
  `--run-agents` and `--last-failed-file` are refused. The `filtered:` line now reads
  `filtered: <options> narrow or relax the run; not a verification`.
- `verify --require selected` counts a selected run only while `selections/<id>.json` exists and was computed for the
  code the run tested.

### Fixes

- **Passthrough that skips or relaxes checks verified as full (A, P1).** `-G` (`--grep-invert`) and its attached form
  `-Gpattern`, `--ignore-snapshots`, `-u`/`--update-snapshots`, `--update-source-method`, `--no-deps`,
  `--pass-with-no-tests`, `--retries`, `--timeout`, `--global-timeout`, `--tsconfig`, `--browser` and `--add-reporter`
  were neutral: a full run that ignored a failing snapshot or left a failing test out verified and moved last-green.
  They now make the run `filtered`. Short clusters are read as commander reads them (`-xc file` holds `-c`: refused).
- **A dirty-tree pass moved last-green to HEAD (B, P1).** The fingerprint gains `clean` (no tracked change against
  HEAD, no untracked non-ignored file outside the ledger dir; not part of `id`). last-green moves only for a full pass,
  or a complete `shard merge`, of a clean tree; otherwise the run prints
  `last-green not moved: the working tree had uncommitted changes`. A dirty pass still verifies its own code. `verify`
  offers only a clean pass's head as `last verified head`, and says
  `no full pass of a committed tree yet, so no base to narrow from` when every pass had uncommitted changes.
- **A stale selection ran and verified (C, P1).** `run --selection` on a selection computed for other code computes it
  again from the same base, head and uncommitted setting (same apps), prints
  `selection <old> was for other code — reselected as <new>`, carries over its `--add` entries (not its `--remove`
  entries) and runs the new one. When the code changes while a selection run waits for the lock, the run stops under
  the lock with `the code changed while waiting for the lock (selection <id> no longer matches); run it again`, writes
  no ledger line and releases the lock.
- **The declared minimum Playwright could not run selected runs (D, P2).** Besides the floor above: running the
  contract suite on 1.56.0 showed that 1.56.x and 1.57.x match a `--test-list` line only on a test's whole title path
  (1.58.0 made it a prefix), so the file-level lines e2e-rail writes matched nothing there. On those versions a run
  lists the tests under the lock and hands Playwright one whole-title line per test the list covers
  (`.e2e-rail/reports/<run-id>.test-list.txt`); the list, the ledger's `command` and the empty-list check stay as
  written. CI runs the contract suite on 1.56.0 too.

### Docs

- A seeded-failure drill for the shadow period (E): in the shadow skill and both READMEs — break a selected spec on a
  scratch branch, check that `select` names it and `run --selection` fails, see a planted unrelated failure fail the
  full run, never `shadow record` a drill, revert.

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
