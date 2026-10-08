# e2e-rail

<div align="right">
  <a href="README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-lightgrey?style=flat-square" alt="한국어"/></a>
  <a href="README.md"><img src="https://img.shields.io/badge/lang-English-blue?style=flat-square" alt="English"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"/></a>
</div>

Change-aware Playwright E2E for any frontend repository:

1. **Select** only the specs a change can reach, with a reason for each, and widen to the full suite whenever it cannot tell.
2. **Record** every run against a fingerprint of the code it tested, so "it passed earlier" is checked, never assumed.
3. **Split** the load: one heavy run per machine, worker counts and shards chosen from measurements.

It is a zero-dependency Node CLI (`e2e-rail`) that your scripts and CI call, plus skill layers for **Claude Code** and
**Codex** that make agents use it honestly: no selected, rerun or filtered run reported as a full pass, a selection
block with reasons for every selected run, and `verify` before any claim.

**Status:** v0.2.0 (git tag `v0.2.0`). Requires Node ≥ 20, `@playwright/test` ≥ 1.56 (selected and shard runs use
`--test-list`; e2e-rail refuses an older one) and `typescript` ≥ 5 in the host repository (borrowed, not bundled).

## Install

### The CLI (every runtime and CI)

```sh
pnpm add -D github:sh5623/e2e-rail#v0.2.0
```

Skills and CI always call the copy installed in the repository (`pnpm exec e2e-rail …`, or `npx e2e-rail …` with npm
or yarn), so sessions and CI run the same core and their ledgers compare.

### Claude Code

```text
/plugin marketplace add sh5623/guardrail
/plugin install e2e-rail@guardrail
/reload-plugins
```

Five skills (`/e2e-rail:init`, `select`, `gate`, `measure`, `shadow`), the read-only `e2e-impact-analyst` agent and a
SessionStart hook that injects the doctrine.

### Codex

```sh
codex plugin marketplace add https://github.com/sh5623/e2e-rail.git
codex plugin add e2e-rail@e2e-rail-codex
```

Start a new Codex session, open `/hooks`, review the SessionStart command (`cat "$PLUGIN_ROOT/hooks/doctrine.md"`) and
trust it; installing does not trust hooks. The same five skills are `$e2e-rail:init` … `$e2e-rail:shadow`. Codex has
no agent: the `select` skill reads `references/impact-analyst.md` and runs that checklist itself.

## Setup

About 30 minutes per repository.

1. `pnpm add -D github:sh5623/e2e-rail#v0.2.0`
2. Install the Claude Code or the Codex plugin (above).
3. Run the `init` skill, or by hand `pnpm exec e2e-rail init`: it writes `e2e-rail.config.mjs` (one app per
   `playwright.config.*` found), picks the tsconfig that holds your `paths`, adds `.e2e-rail/`, `test-results/`,
   `playwright-report/` and `blob-report/` to `.gitignore`, and prints three `package.json` scripts to consider.
4. `pnpm exec e2e-rail map --check`: fix what the verdict names, then give unmapped specs literal routes.
5. Make the full gate `pnpm exec e2e-rail run --full`, and close every round with the `shadow` skill. After
   `shadow.promoteAfter` hits in a row a human runs `shadow promote`; from then on, during development, `select` and
   `run --selection` replace the full suite, and the full run moves to the integration step.

## How it decides

### Selection rules

`pnpm exec e2e-rail select --base <ref>` diffs `<ref>..HEAD` (plus uncommitted and untracked files locally; not under
`CI`, and not with `--no-uncommitted`) and classifies each changed file by the first matching row:

| # | Changed file | Result (reason) |
| --- | --- | --- |
| 1 | matches `ignore` or the app's `tiers.ignore` (never a test file under `specDir`), or lies in the ledger dir | ignored |
| 2 | matches `shared` | every app full (`shared:<file>`) |
| 3 | outside every app root, or outside the config root | every app full (`unknown-root:<file>`) |
| 4 | matches the app's `tiers.full` (always includes `supportDirs/**`, which cannot be removed, the Playwright config and `package.json`) | that app full (`tier-full:<glob>`) |
| 5 | a test file (`*.spec.*` or `*.test.*`) in `specDir` | that spec (`spec-self:<file>`); one Playwright does not list (so the index does not know it): app full (`spec-unindexed:<file>`) |
| 6 | under `srcDir` | the specs it reaches (below); a blind spot runs the app full |
| 7 | any other file of the app | that app full (`app-other:<file>`) |
| – | no base, or git cannot diff | every app full (`no-base`) |
| – | `--head <ref>` names a commit other than HEAD | every app full (`head-not-HEAD:<ref>`): a run tests the work tree, commits after `<ref>` included |

For row 6 the import graph climbs from the changed files to the route entries they reach. A spec is selected when its
routes match a reached route (`route:<route> ← <file>`), its `page.route()` mocks match an API literal in the changed
files (`api:<glob> ← <literal>`), or it imports code that depends on the change (`import:<file>`). Every `unmapped`
spec and every `alwaysRun` spec ride along. The app runs in full instead when the adapter cannot read a route table
(`adapter-unresolved:…`), when a changed file is not in the graph or any internal import does not resolve
(`graph-unresolved:<file>`), or when the climb reaches the app entry through shell, stores or layout
(`graph-shell:<file>`). **Unknown is never "no change": it widens.** Exit 0 = every app partial, 10 = some app full.

### Spec index and route entries

`map` indexes each spec (cached in `.e2e-rail/map.<app>.json`): its routes (`goto` literals and templates with a
literal prefix, `basePath` removed), its API globs (`route()` mocks), the source files it imports, its support helpers
and its Playwright projects (from `playwright test --list`). The specs are exactly the test files Playwright lists,
whatever their name (`*.spec.*`, `*.test.*`, a custom `testMatch`) and whatever `tiers.ignore` says; a file it does not
list has no project to run in and is not indexed. Literal `goto` calls inside the support helpers a spec
imports are merged into its routes, but they never rescue a spec whose own navigation cannot be read: that spec is
**unmapped** and runs on every src change. The unmapped share is the ceiling of what selection can save.

The `react-router-lazy` adapter reads `path` + lazy `import()` pairs from `adapter.routeFiles`. A leaf maps to its
exact path; a route with `children` is a layout and maps its module to `<path>/*` (the root layout to `*`), because a
layout affects every route below it. The `manual` adapter takes `adapter.map`. Either adapter narrows only when
`adapter.routeFiles` lists the route-table files: they bound the climb, otherwise every page reaches the app entry
through the router. The entry is `src/main.*` or `src/index.*`, or `main` when set.

### Fingerprint, ledger, verify

Each run records a fingerprint: `head`, a hash of the uncommitted `diff`, a hash of the `untracked` files (minus the
ledger dir), a hash of both configs, the Playwright version and, in preview mode, a hash of the built `dist`. `id`
covers all of it; `codeId` covers head, diff and untracked files and pairs selections with runs; `clean` (not part of
`id`) says the tree was HEAD itself: no tracked change and no untracked, non-ignored file outside the ledger dir.
`.e2e-rail/ledger.jsonl` gets one append-only line per run: `kind` (`full` · `selected` · `rerun` · `shard`), `mode`,
fingerprint, `testListSha` (the sha256 of the test list it read), shard, workers, `filtered`, `shadowed`, lock times,
rc, per-spec results, failures and flaky tests. An
unfiltered passing full run of a clean tree writes its head to `.e2e-rail/last-green.<app>`, the next selection's
base; so does `shard merge` when it prints `complete: yes` for shards that ran on a clean tree. A pass with
uncommitted changes verifies that exact code but never its HEAD: it prints
`last-green not moved: the working tree had uncommitted changes`, and `verify` never offers its head as a base.

`verify` answers "has exactly this code passed?" from the ledger: only runs of this app, in this mode, with this
fingerprint, that passed and were not filtered count. `--require full` wants a full run or a complete shard set;
`--require selected` also takes a selected run made by `run --selection` (it prints
`verified: selected@<run-id> (selection <id>[, shadowed]) (<age>)`) while its `selections/<id>.json` exists, was
computed for the code the run tested and still writes the list the run read (a `select --add` after the run needs a
new run); an ad-hoc `--test-list` run or a `measure workers` run does not count. A rerun never counts. Preview mode rebuilds a missing or stale dist
(older than any file git knows) before it runs; `--no-build` refuses instead.

## Commands

| Command | Options | Prints · exit |
| --- | --- | --- |
| `init` | `--force` | writes `e2e-rail.config.mjs` · `.gitignore` lines · suggested scripts · 0 |
| `map` | `--app <name>` · `--check` · `--explain <spec>` | `app <name>: <n> specs indexed · …` · with `--check`: `graph:`, `verdict:`, `unmapped: <u>/<n> (<p>%)` · 0 |
| `select` | `--app <name>` · `--base <ref>` · `--head <ref>` · `--no-uncommitted` · `--json` · `--add <spec>` · `--remove <spec>` · `--reason <text>` | the table `app  mode  specs  unmapped  reasons` · `selection.json` · `test-list.<app>.txt` · 0 partial · 10 full |
| `run` | `--app <name>` · `--full` · `--selection [id]` · `--test-list <file>` · `--last-failed` · `--mode dev\|preview` · `--workers N` · `--project <name>` · `--shard i/n` · `--blob` · `--no-lock` · `--no-build` · `-- <playwright args>` | `run-id <id> · kind <kind> · rc <rc> · <ms>ms · failures <n>` · `failed:` lines · `filtered: …` · `shadowed: …` · Playwright's exit code (1 when a test list matched nothing) |
| `verify` | `--app <name>` · `--mode dev\|preview` · `--require full\|selected` · `--max-age <min>` · `--json` | `verified: …` 0 · `stale: …` 20 · `insufficient: …` 21 |
| `shadow` | `record --run <run-id> [--app <name>]` · `status` · `promote` · `demote` | `shadow: <run-id> hit\|miss\|trivial\|unpaired · streak <s>/<n>` · `trust <t> · streak <s>/<n> · promotable <yes\|no>` · 0 |
| `measure` | `--app <name>` · `slowest [-n N]` · `retries [--last N]` · `workers <1,2,4> --test-list <file> [--mode dev\|preview]` | tables · 0 |
| `shard` | `--app <name>` · `plan --count N [--from-run <run-id>] [--include <spec>] [--mode dev\|preview]` · `merge --dir <blob dir> [--mode dev\|preview]` | `manifest:` and `shard <i>/<n>` lines · `merge: rc <rc> · html … · complete: yes\|no` · merge-reports' exit code |
| `lock` | `status` · `reap` · `run <heavy\|light> -- <command…>` | holders · reaped locks · the command's exit code (127 if it cannot start) |

Global: `--version`, `--help`, `<command> --help`. Every error is one `e2e-rail: <message>` line on stderr: exit 2 for
bad usage, 1 for anything else. Run-shaping options are first-class flags; after `--` the CLI refuses `--shard`,
`--test-list`, `--test-list-invert`, `--last-failed`, `--last-failed-file`, `--list`, `--only-changed`, `--reporter`,
`--output`, `-c`, `--config`, `--ui`, `--debug` and `--run-agents` before anything runs. After `--` only `--headed`,
`--quiet`, `--trace <mode>`, `--repeat-each <n>`, `--fail-on-flaky-tests`, `--forbid-only`, `--fully-parallel`,
`--max-failures <n>`, `-x` and `-j`/`--workers <n>` leave a run what its kind says. Anything else there — a test
filter (`-g`, `-G`, `--grep`, `--grep-invert`, `--project`, a file), an option that skips or relaxes a check
(`--ignore-snapshots`, `-u`, `--retries`, `--timeout`, `--no-deps`, `--pass-with-no-tests`, …) or an option e2e-rail
does not know — makes the run filtered, as `--project` does: it prints `kind full (filtered)` and
`filtered: <options> narrow or relax the run; not a verification`, and never verifies or moves last-green.
`run --selection` on a selection that writes no
test-list line for the app prints `<app>: nothing selected (partial, 0 specs)` (or `…, <n> spec(s), 0 test-list lines`
when no selected spec has a Playwright project), runs nothing and records nothing. A run from a test list (a
selection, a shard plan or `--test-list <file>`) whose list matches no test is recorded as a failure (rc 1,
`failed: test list matched no tests`) although Playwright exits 0 there; so is one with a line that matches nothing
(`failed: test list line matched no tests: <line>`), unless the run is filtered (narrowed on purpose).
On Playwright 1.56–1.57, whose `--test-list` matches a line only on a whole title path, e2e-rail lists the tests
first and hands Playwright one such line per test the list covers (`.e2e-rail/reports/<run-id>.test-list.txt`); the
list itself, and the check above, stay as written.
`run --selection` on a selection computed for other code (files changed since `select`) computes it again from the
same base and uncommitted setting up to HEAD, prints `selection <old> was for other code — reselected as <new>` (carrying
over its `--add`s, not its `--remove`s) and runs the new one; it becomes the current selection only when the run used
the current one (`run --selection <id>` of another selection writes `selections/<new>.json` alone). Each selection
run hands Playwright a list file of its own (`.e2e-rail/reports/<selection>.<app>.<pid>.test-list.txt`, deleted
afterwards). If the code changes while the run waits for the lock,
it stops with `the code changed while waiting for the lock (selection <id> no longer matches); run it again` and
records nothing.

## Shadow mode

The selector earns trust before it replaces the full suite. `.e2e-rail/state.json` starts at `trust shadow`. While it
does, every selected run is recorded and printed as `shadowed`, and `select --remove` is refused.

At the end of a round: compute `select` on the exact code the integration full run tests, run the full suite, then
`pnpm exec e2e-rail shadow record --app <app> --run <run-id>`. The run is paired with the selection made for the same
`codeId`: `hit` (every failed spec was selected, so a passing run is a hit) adds one to the streak; `miss` resets it
and names the missed specs; `trivial` (the selection was full) and `unpaired` (no selection for this code) leave it
alone. Filtered, rerun, selected and shard runs are refused, and so is a failed run with no recorded failure. When
`shadow status` prints `promotable yes`, a human may run `shadow promote`; nothing promotes automatically.
`shadow demote` returns to shadow with streak 0. Shadow mode costs nothing: the full run happens anyway.

### Seeded-failure drill

A streak counts what the selection caught; a drill shows that it catches a real break. During the shadow period, on a
scratch branch (`git switch -c e2e-drill`), pick a recent change and break the code it touches so that a spec that
should be selected fails. Run `select --app <app> --base <base>` and check that the spec is in the selection, with a
reason naming the broken file; then `run --app <app> --selection` must fail. A selection without the spec, or a passing
run, is a selector miss to fix like a shadow miss. Plant a failure in an UNRELATED spec as well: the full run fails
and, paired with the selection, shows as a miss. That is expected; a miss resets the streak only when the failure is
genuine, so a drill's full runs are never recorded with `shadow record`. Then revert: leave the scratch branch and
delete it.

## Locks, workers and sharding

**Lock.** One lock serves the whole machine (every repository and worktree), in a private 0700 directory under the
temp dir; `E2E_RAIL_LOCK_DIR` moves it. Full and shard runs, runs without a worker count, and `measure workers` take
the exclusive heavy lock; other runs share two light slots. A waiting heavy run keeps new light runs out.
`pnpm exec e2e-rail lock status` shows the holders, `lock reap` removes locks whose process is gone, and
`lock run heavy -- <command>` wraps any other command in the same lock.

**Workers.** e2e-rail never chooses a worker count. `pnpm exec e2e-rail measure workers 1,2,4 --test-list <file>`
runs the same list once per count, each under the exclusive lock, and prints wall time, failures, retries and load.
A human writes the winner into `run.workers` (`local`, `ci`; CI defaults to 1).

**Sharding.** Native: each job runs `pnpm exec e2e-rail run --app <app> --full --shard <i>/<n> --blob`. Planned:
`pnpm exec e2e-rail shard plan --app <app> --count <n>` splits the tests Playwright lists now by measured durations
(longest first, onto the lightest shard; untimed specs weigh the median) into `.e2e-rail/shards/<app>/<i>.txt` plus
a `manifest.json` holding each list's sha256; each job then runs
`run --test-list .e2e-rail/shards/<app>/<i>.txt --shard <i>/<n>`. A list run with another index or count, edited, or
from another app's plan is refused. `shard merge --dir <blob dir>` merges the blob reports into one HTML report and
prints `complete: yes` only when every shard of ONE split passed on this exact code: all native `i/n` of one `n`, or
every list of one plan made for this code. Only then does `verify` count the set as a full run.

## CI templates

In `templates/ci/` (copy them; e2e-rail does not install them):

- `github-actions-shard.yml` — build once, a matrix of native shards (`run --full --shard <i>/<n> --blob`), then a
  merge job that appends the shards' ledger lines and runs `shard merge` and `verify --require full`. A commented
  variant plans the shards in a job of its own and hands `.e2e-rail/shards/<app>/` to the matrix.
- `codebuild-batch.yml` — the same shape as a CodeBuild batch `build-graph`, handing dist, blob reports and ledger
  lines over through S3.
- `buildspec-snippet.yml` — the shadow-period gate: `select`, then `run --full --mode preview`, then
  `shadow record --run <run-id>` with the run id taken from the summary line; `.e2e-rail/` stays in the build cache.

A file downloaded into the work tree changes the fingerprint, so the templates put downloads under `$RUNNER_TEMP` or a
temp dir and ledger lines into `.e2e-rail/`, which the fingerprint ignores.

## Configuration

`e2e-rail.config.mjs` at the repository root. Paths are relative to the app root unless noted; unknown keys warn.

| Key | Default | Meaning |
| --- | --- | --- |
| `apps[].name` · `root` · `playwrightConfig` | required | app name, its directory (repo-relative), its Playwright config (must exist) |
| `specDir` · `supportDirs` | `e2e` · `[<specDir>/support]` | specs; helpers the specs import (a change there runs the app in full) |
| `srcDir` · `tsconfig` · `main` | `src` · `tsconfig.json` · detected | source root; the tsconfig whose `paths` resolve aliases; the app entry when not `src/main.*` or `src/index.*` |
| `adapter.name` | required | `react-router-lazy` or `manual` |
| `adapter.routeFiles` · `basePath` · `map` | `[]` · `''` · `{}` | route-table globs (needed to narrow); the prefix the router adds; for `manual`: `{ '<route>': ['src/…'] }` |
| `apiPrefix` · `alwaysRun` | `/api` · `[]` | API URL prefix read from source literals; spec slugs that run in every selection |
| `tiers.full` · `tiers.ignore` | support dirs, Playwright config, `package.json` · unit tests under `srcDir` (`<srcDir>/**/*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`) and `**/*.md` | globs that run the app in full · that never trigger a run (a test file under `specDir` is never ignored: Playwright runs `*.test.*` too) |
| `run.preview` | none | `{ build: '<command>', dist: '<dir>' }` for `--mode preview` |
| `run.workers` · `run.modeEnv` · `run.env` · `run.port` | `{ ci: 1 }` · `{}` · `{}` · none | measured worker counts; env per mode; env for every run (e2e-rail injects none); informational |
| `shared` · `ignore` | `[]` · `['**/*.md', 'docs/**']` | repo-relative globs that run every app in full · that never trigger a run |
| `shadow.promoteAfter` · `ledger.dir` | `3` · `.e2e-rail` | hits in a row before `promotable yes`; the ledger directory (gitignored) |

A monorepo app as adopted (184 route entries, 0 unresolved):

```js
export default {
  apps: [
    {
      name: 'bfm',
      root: 'apps/bfm',
      playwrightConfig: 'playwright.config.ts',
      tsconfig: 'tsconfig.app.json',            // the referenced config with `paths`; tsconfig.json is solution-style
      adapter: {
        name: 'react-router-lazy',
        routeFiles: ['src/features/**/routes.tsx', 'src/routes/router.tsx'],
        basePath: '/app',
      },
      tiers: {
        full: ['src/routes/**', 'src/components/layout/**', 'src/stores/**', 'src/lib/api/**'],
      },
      run: {
        preview: { build: 'pnpm -F bfm build', dist: 'dist' },
        modeEnv: { preview: { E2E_PREVIEW: '1' } },
      },
    },
  ],
  shared: ['packages/**', 'pnpm-lock.yaml', 'tsconfig*.json'],
};
```

## Limits

Static analysis can still narrow wrongly in these cases. Each has a mitigation, and shadow mode counts what slips
through before anyone trusts a selection.

- **Runtime string navigation and click-only flows** (`navigate('/x')`, a page reached only by clicking): the import
  graph does not follow them. Put the shell and router in `tiers.full`; the impact-analyst checklist looks for them.
- **`import.meta.glob(…, { base })` and `(import.meta as any).glob`**: not resolved as edges. Add the globbing
  module's directory to `tiers.full`; the impact-analyst checklist asks about them.
- **A Vite `resolve.alias` that tsconfig `paths` does not mirror**: imports through it are invisible. Mirror every
  alias in `paths`; the impact-analyst checklist asks about them.
- **Route arrays built by helper calls** and **modules used as `errorElement`**: the adapter may not read them as
  route entries. List those files in `tiers.full`.
- **API globs that only constrain a URL tail** (`**/items`): a source literal with a dynamic tail
  (`/api/orders/${id}/items` is read as `/api/orders/*`) is not matched against them, so a spec that mocks only the
  tail is not selected on the API axis. Write mock globs with the path prefix (`**/api/orders/**`); the
  impact-analyst checks services and their mocks.
- **Gitignored build inputs** (e.g. `.env.local`) and **already-committed deletions** do not mark `dist` stale.
  Rebuild after changing them (or delete `dist`), so preview mode builds again.
- **Projects chosen by environment**: the spec index lists tests in the dev environment (`run.env` + `run.modeEnv.dev`).
  A Playwright config whose projects or `testDir` depend on the env (for example on `run.modeEnv.preview`) can list
  other projects in preview, so a selection run with `--mode preview` may miss a preview-only project (a line for a
  project preview does not have fails the run instead). `shard plan --mode preview` lists in the preview env. Keep the
  project set independent of the mode, or gate preview with `run --full`.

These shapes never narrow wrongly, but they always run the app in full (measured on the sample app):

- **A route table written as `export default [...]` and spread from another route file**
  (`import cartRoutes from './routes'` … `children: [...cartRoutes]`): the adapter follows only `const` arrays.
  `map --check` prints `! src/router.ts:6: spread of 'cartRoutes' is not a const array literal declared in this file or
  in a file routeFiles covers (imported from '@/features/cart/routes')` and
  `verdict: every src change will run full: the react-router-lazy adapter could not read 1 route definition(s) …`;
  `select` prints `adapter-unresolved:…`. Export it as `export const cartRoutes = [...]`.
- **A leaf whose page is a local `lazy()` const or an arrow**: `const Page = lazy(() => import('./Page'))` used as
  `Component: Page` or `element: <Page />`, and `Component: () => <Page …/>`. The route gets no entry. `map --check`
  prints no `!` line (the `route entries` count is one short of the routes, and the verdict can still say
  `narrowing possible`); an edit to that page climbs through the route table to the app entry, so `select` prints
  `graph-shell:<page file>`. Use the route's `lazy` field or `Component:` with an imported page.
- **Non-code files under `srcDir`** (`.css`, `.svg`, `.json`, …): they are not in the import graph. `map --check` says
  nothing about them; an edit makes `select` print `graph-unresolved:<file>`.

The fingerprint's `config` field hashes `e2e-rail.config.mjs` and the app's Playwright config only, not the local
modules `playwright.config.ts` imports. An edit to such a module still moves `head`, `diff` or `untracked` (so
`verify` is stale, and `differing` names those, not `config`). A gitignored file it reads (an env file, for example) is not covered at all:
run the suite again after changing one, since `verify` cannot see it.

On Playwright 1.56–1.57 a `--test-list` line has to spell a test's whole title path, and a title that holds `›` or
starts or ends with a space cannot be spelled. A spec with such a test never runs from a list: every selected run of
it fails (`failed: test list line matched no tests: <line>`), and a shard plan that holds it never completes. Use
Playwright ≥ 1.58, where a line names the file, or rename the test.

## Plugin layer

| Skill | When | What it enforces |
| --- | --- | --- |
| `e2e-rail:init` | a repo without e2e-rail | install, `init`, a config review, `map --check`, the unmapped share |
| `e2e-rail:select` | before running E2E on a change | `select`, the impact-analyst check, `--add` with `--reason`, the selection block |
| `e2e-rail:gate` | running and reporting | `run`, then `verify` in the same mode; the fixed report; reruns and filtered runs are never a full pass |
| `e2e-rail:measure` | slow or flaky suites | slowest and retries, a trace split, `measure workers`, then shards |
| `e2e-rail:shadow` | the end of a round | `shadow record`, `shadow status`, promotion proposed to a human, never automatic |

The selection block every selected run carries:

```text
change:   order search filter (src/features/orders/OrderSearchFilter.tsx +2 more)
selected: orders · order-detail (reasons: route:orders ← OrdersPage.tsx · api:**/api/orders/** ← /api/orders/list)
added:    none      removed: none
mobile:   orders
unmapped: 1 (map --check lists them)
final:    full run in the integration step · trust shadow
```

`e2e-impact-analyst` (Claude Code, read-only: Read, Grep, Glob, Bash) checks what the graph cannot see — string
navigation, modal openers, services without API literals, fixtures outside `supportDirs`, runtime routes, URL state,
mobile branches — and returns only `--add` candidates with reasons, never removals. Codex runs the same checklist
from `references/impact-analyst.md`. The SessionStart doctrine (`hooks/doctrine.md`) keeps six rules in every session.

## Development

```sh
npm test               # node:test, no dependencies; includes the plugin-layer checks
npm run test:contract  # against real Playwright (E2E_RAIL_CONTRACT=1)
npm run sync:codex     # mirror skills/, references/ and hooks/doctrine.md into plugins/e2e-rail/
```

`skills/` is canonical; the Codex package copy must match it (a test fails otherwise). The design and the plans are in
`docs/superpowers/`.

## License

MIT © 2026 Seungho
