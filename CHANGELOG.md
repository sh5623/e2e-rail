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
- `verify --require selected` counts a selected run only while `selections/<id>.json` exists, was computed for the
  code the run tested and still writes the test list the run read (ledger `testListSha`). Selected runs recorded by
  0.1.0 have no list hash and no longer count.

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
  again from the same base and uncommitted setting up to HEAD (same apps), prints
  `selection <old> was for other code — reselected as <new>`, carries over its `--add` entries (not its `--remove`
  entries) and runs the new one; the reselection replaces `selection.json` only when the run used the current
  selection (`run --selection <id>` of another one writes `selections/<new>.json` alone). A selection run hands
  Playwright a list file of its own (`.e2e-rail/reports/<selection>.<app>.<pid>.test-list.txt`, deleted afterwards),
  so another `select` during a long lock wait cannot swap it. When the code changes while a selection run waits for the lock, the run stops under
  the lock with `the code changed while waiting for the lock (selection <id> no longer matches); run it again`, writes
  no ledger line and releases the lock.
- **A selection made with `--head` other than HEAD verified code it never looked at (G1).** A run always tests the
  work tree, so the commits between that head and HEAD were run but never selected for. `select --head <ref>` with a
  `<ref>` that resolves to a commit other than HEAD now runs every app in full (`head-not-HEAD:<ref>`), and a
  reselection always diffs up to HEAD.
- **Uncommitted work left out of a selection still ran and verified (H1).** With `--no-uncommitted`, or under `CI`
  where it is the default, the selection ignored the uncommitted diff while its codeId, and the run, included it.
  On a tree with uncommitted or untracked (non-ignored, outside the ledger dir) changes such a selection now runs
  every app in full (`uncommitted-excluded`); a clean tree narrows as before.
- **A selection made up to another head still ran and verified when its codeId matched (H2).** A selection file
  whose `head` does not resolve to HEAD (as 0.1.0 wrote one for `select --head <sha>`) is now reselected up to HEAD
  by `run --selection` (`selection <old> was made up to <head>, not HEAD — reselected as <new>`), and
  `verify --require selected` no longer credits a run whose selection's head is not the commit the run tested.
- **A selection file that left uncommitted work out of a dirty tree still ran and verified (I1).** Whoever wrote it
  (0.1.0 `select --no-uncommitted`, or any producer), a selection with `includeUncommitted: false` kept its codeId and
  head, so it narrowed and its run verified although the uncommitted work ran unselected. `run --selection` now
  reselects such a selection while the tree is not clean
  (`selection <old> left out uncommitted work in a tree that is not clean — reselected as <new>`), and
  `verify --require selected` never credits its run on a tree the run found dirty. verify names why a selection run
  no longer counts (`… was made up to a head other than the one it ran` / `… left out uncommitted work the run
  included`, next to the H5 list line).
- **`select --add` after a run verified the amended selection with the earlier run (G2).** `select --add` rewrites
  the selection under the same id and code, so a run that never ran the added spec counted. Each run from a test list
  now records `testListSha` (the sha256 of the list as read under the lock, before any 1.56–1.57 spelling-out), and
  `verify --require selected` compares it with the list the selection writes now.
- **The declared minimum Playwright could not run selected runs (D, P2).** Besides the floor above: running the
  contract suite on 1.56.0 showed that 1.56.x and 1.57.x match a `--test-list` line only on a test's whole title path
  (1.58.0 made it a prefix), so the file-level lines e2e-rail writes matched nothing there. On those versions a run
  lists the tests under the lock and hands Playwright one whole-title line per test the list covers
  (`.e2e-rail/reports/<run-id>.test-list.txt`, deleted after the run); the list, the ledger's `command` and the empty-list check stay as
  written. CI runs the contract suite on 1.56.0 too. Limit: there a title that holds `›` or a line break, starts or
  ends with whitespace, or is empty cannot be spelled as a line, so a spec with such a test fails every list run and a shard plan holding it
  never completes; Playwright ≥ 1.58 is recommended.

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
