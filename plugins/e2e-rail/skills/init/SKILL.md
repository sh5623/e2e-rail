---
name: init
description: Use when a repository with Playwright E2E tests does not use e2e-rail yet (no e2e-rail.config.mjs, or `pnpm exec e2e-rail` is missing), or when its config needs review after adding an app, a route table, a monorepo package or a new tsconfig. Installs the CLI, writes the config, checks how well specs map to source with `map --check`, and reports what keeps selections wide. Do NOT load for: deciding a change's scope (select), running and reporting tests (gate), speed, workers or sharding (measure), shadow pairing or promotion (shadow).
---

# e2e-rail:init — install, configure, check the mapping

From the repository root. npm or yarn repos: `npx e2e-rail` instead of `pnpm exec e2e-rail`.

## 1. Install
```sh
pnpm exec e2e-rail --version
```
A version (`0.1.0`) → installed. Otherwise ask the human first: adding the devDependency edits `package.json` and the
lockfile, and nothing edits `package.json` without a yes. On a yes:
```sh
pnpm add -D github:sh5623/e2e-rail#v0.1.0
```
It needs Node ≥ 20 and borrows the repo's own `@playwright/test` 1.56 or newer and `typescript`; an older
Playwright is refused (`@playwright/test 1.56.0 or newer is required (found <x>)`): ask the human to upgrade it.

## 2. Write the config
```sh
pnpm exec e2e-rail init
```
It finds every `playwright.config.*` below the root and writes `e2e-rail.config.mjs` for the first one; the others are
listed in a comment at the end of the file (add the ones that are apps to `apps[]`). It picks the tsconfig that holds
`compilerOptions.paths` (a solution-style `tsconfig.json` with only `references` is replaced by the referenced config
that has `paths`), keeps only the `adapter.routeFiles` globs that match a file, and appends `.e2e-rail/`,
`test-results/`, `playwright-report/` and `blob-report/` to `.gitignore` where git does not ignore them yet.
Quote its notes (lines about `tsconfig.json is solution-style …` or `adapter.routeFiles: …`) in your report.
An existing config is left alone (`e2e-rail.config.mjs exists; left unchanged`). `init --force` overwrites it: only
when a human asks. It then prints three `package.json` scripts; when the app's config declares `run.preview`, the
`e2e:run` and `e2e:verify` scripts carry `--mode preview` (verify only matches runs of its own mode).

## 3. Review the config with a human
- `adapter.routeFiles` — the files that hold the route tables. Narrowing needs them with either adapter: without them
  a page change climbs through the router up to the app entry and the app runs in full. The `manual` adapter also
  takes `adapter.map = { '<route>': ['src/…'] }`.
- `adapter.basePath` — the prefix the router puts in front of every route (for example `/app`).
- `tsconfig` — the config whose `paths` resolve your import aliases. `main` — the app entry, when it is not
  `src/main.*` or `src/index.*`.
- `tiers.full` — shell code whose change must run the whole app: router, layout, stores, auth, API client, styles.
- `run.preview` (`build`, `dist`) and `run.modeEnv` — what the repo's preview E2E needs. e2e-rail injects no env.
- `alwaysRun` — smoke spec slugs that ride along with every selection.

## 4. Check the mapping
```sh
pnpm exec e2e-rail map --check
```
Per app, read:
- `app <name>: <n> specs indexed · <m> route entries · adapter unresolved <k>` and its `! …` lines — fix
  `adapter.routeFiles` until `adapter unresolved 0`.
- `graph: <files> files · missing <x> · opaque <y> · main <entry>` — `missing` above 0 means imports that do not
  resolve (fix `tsconfig`/`paths`); while it is, every src change runs the app in full. `main none` → set `main`.
- `warning: <n> tests outside specDir — set specDir to Playwright rootDir …` and its `outside:` lines — those test
  files are indexed `unmapped` (they run on every src change) and never read: point `specDir` at that rootDir.
- `verdict: narrowing possible (…)` or `verdict: every src change will run full: <why>` — fix what it names.
- `unmapped: <u>/<n> (<p>%) — these run on every src change`, then the list.

Why one spec maps as it does: `pnpm exec e2e-rail map --app <app> --explain e2e/<spec>.spec.ts` prints its routes,
apis, imports, supports, projects and `unmapped`. A spec is unmapped when its own `goto` calls cannot be read as a
literal route (a computed URL, a bare `goto(…)` helper) or it has none, or when it or a helper it imports has an import
inside the app that does not resolve.

## 5. Report
```
e2e-rail init — <app>
config:   e2e-rail.config.mjs (apps: <names>) · notes: <init's notes> | none
map:      <n> specs · <m> route entries · adapter unresolved <k> · graph missing <x>
verdict:  <the verdict line, verbatim>
unmapped: <u>/<n> (<p>%) — top 5: <spec — why it cannot be mapped>
proposal: <per top unmapped spec: the literal route constant to goto, e.g. ROUTES.orders = '/app/orders'>
scripts:  <the three package.json scripts init suggested (run and verify with `--mode preview` when the app declares
          run.preview)> — add them?
next:     gate the full suite with `run --full`; trust starts as shadow (e2e-rail:shadow)
```
Ask before adding the suggested `package.json` scripts; never edit `package.json` without a yes. Do not commit the
config for the human: the repo's git rules decide that.
