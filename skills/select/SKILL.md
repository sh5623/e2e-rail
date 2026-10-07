---
name: select
description: Use when a code change needs its E2E scope decided — before running Playwright on a branch, worktree or PR, or when asked "which E2E specs does this change need?". Computes the selection with the e2e-rail CLI, checks the couplings the script cannot see, and produces the selection block (change · selected specs · reasons · mobile · unmapped · final full) that every selected-run report must carry. Do NOT load for: running or reporting tests (gate), first-time setup (init), speed, workers or sharding (measure), shadow pairing or promotion (shadow).
---

# e2e-rail:select — decide the E2E scope and record why

Run every command from the repository root (where `e2e-rail.config.mjs` lives). npm or yarn repos: `npx e2e-rail`
instead of `pnpm exec e2e-rail`. Without `--app`, `select` covers every app of the config; `--add`, `run` and
`verify` need `--app <app>` when there are several.

## 1. Pick the base
The base is the last commit that passed a full verification on a clean tree. In this order:
1. `pnpm exec e2e-rail verify --app <app> --mode <mode>` — `verified:` means this exact code already passed in full:
   nothing to select, report it through `e2e-rail:gate`. A `stale:` line that ends with `last verified head <sha>`:
   use it. `no full pass of a committed tree yet` (every pass had uncommitted changes): go on to 2.
2. `cat .e2e-rail/last-green.<app>` — written by every unfiltered passing `run --full` of a clean tree, and by a
   `shard merge` that printed `complete: yes` for shards run on a clean tree; never by a pass with uncommitted changes.
3. The merge-base with the target branch: `git merge-base HEAD origin/main`.

No base → leave `--base` out and accept a full selection. Never pick a base to get a smaller selection.

## 2. Compute
```sh
pnpm exec e2e-rail select --app <app> --base <sha>
```
Exit 0 = every covered app is partial · 10 = some app runs in full · 1 error · 2 usage. Locally, uncommitted and
untracked files are included (`+ uncommitted` in the header line); `--no-uncommitted` leaves them out; under `CI` they
are out by default. Output: the table `app  mode  specs  unmapped  reasons`, then `.e2e-rail/selection.json` (per app:
`mode`, `specs[].file`, `specs[].projects`, `specs[].reasons`, `changedFiles`) and, for a partial app,
`.e2e-rail/test-list.<app>.txt` (lines `[<project>] › <spec path from Playwright's rootDir>`).

Reasons on a selected spec: `spec-self:<file>` · `route:<route> ← <file>` · `api:<glob> ← <literal>` ·
`import:<file>` · `unmapped` (the index cannot map that spec, so it runs on every src change) · `always-run` ·
`added: <reason>`.

A full app names why. Whatever the script cannot attribute widens, never narrows: `no-base` · `shared:<file>` ·
`unknown-root:<file>` (outside every app root or outside the config root: every app runs in full) ·
`tier-full:<glob>` · `support:<file>` · `app-other:<file>` · `spec-unindexed:<file>` · `adapter-unresolved:<…>` ·
`graph-unresolved:<file>` (also when any internal import does not resolve) · `graph-shell:<file>` (the change
climbs to the app entry: shell, stores, layout). A full app is a correct answer; do not argue it down.

## 3. Check what the script cannot see (partial apps only)
- Claude Code: delegate to the `e2e-impact-analyst` agent with the diff (`git diff <base>` plus `git status --short`)
  and `.e2e-rail/selection.json`.
- Codex: read `references/impact-analyst.md` of this plugin (`../../references/impact-analyst.md` from this file)
  and run its checklist yourself.

It returns `- add e2e/<spec>.spec.ts — <reason>` lines or `no additions`. Apply each addition:
```sh
pnpm exec e2e-rail select --app <app> --add e2e/<spec>.spec.ts --reason "<one sentence>"
```
`--add` amends the current selection and rewrites its test list; it does not take `--base`/`--head`. Spec paths are
app-relative, as `map --explain` prints them. One call per addition keeps each reason (several `--add` in one call
share one `--reason`).

Never `--remove` while `pnpm exec e2e-rail shadow status` prints `trust shadow` (the CLI refuses it anyway). After a
human ran `shadow promote`: `select --remove <spec> --reason "<why>"`, and the removal goes into your report.

## 4. Write the selection block (paste it into your report verbatim)
```
change:   <what changed, one line> (<top files> +<n> more)
selected: <spec slugs> (reasons: route:… · api:… · import:… · unmapped · always-run)
added:    <slug — reason> | none      removed: <slug — reason> | none
mobile:   <slugs whose test-list lines include a mobile project (a project with a mobile device)> | none
unmapped: <the unmapped column of the select table> (map --check lists them)
final:    full run in the integration step · trust <shadow|selected> (as shadow status prints it)
```
For an app that runs in full, write `selected: all — app runs in full (<reasons>)` and `mobile: all projects`.
One block per app.

## 5. Hand off
`e2e-rail:gate` runs it (`run --selection`). Do not run `playwright test` yourself. If files change after this step,
`run --selection` selects again from the same base (`selection <old> was for other code — reselected as <new>`) and
keeps your `--add`s, not your `--remove`s: update the block from the new selection.
