---
name: gate
description: Use when E2E tests must run and their result be reported — after select, before a commit, merge or handoff, before any "E2E passes" claim, or when asked "did the E2E pass?" or "is this already tested?". Runs the suite through the e2e-rail CLI (machine lock + ledger), verifies the result against the current code fingerprint, and fixes the report format so that no selected, rerun or filtered run is reported as a full pass. Do NOT load for: deciding the scope (select), first-time setup (init), speed, workers or sharding (measure), shadow pairing or promotion (shadow).
---

# e2e-rail:gate — run, verify, report

From the repository root. npm or yarn repos: `npx e2e-rail` instead of `pnpm exec e2e-rail`. `--app <app>` when the
config has several apps. `<mode>` is the repo's E2E mode: `preview` tests the built dist (a missing or stale dist is
rebuilt with `run.preview.build` first) and `dev` is the default. Take the mode the repo's gate uses (its scripts or
CI pass `--mode`); an app with `run.preview` in `e2e-rail.config.mjs` is usually gated in `preview`. Use the same
`<mode>` in every command below.

## 0. Already tested?
```sh
pnpm exec e2e-rail verify --app <app> --mode <mode> --require full
```
`verified: full@<run-id> (<age>)` or `verified: shards×<n>@<run-id> (<age>)` (exit 0): this exact code — commit,
uncommitted diff, untracked files, both configs, Playwright version, and in preview mode the dist — already passed in
full. Report that line; do not rerun. Anything else: run.

## 1. Run
Selected, with the selection block from `e2e-rail:select`:
```sh
pnpm exec e2e-rail run --app <app> --selection --mode <mode>
```
Full:
```sh
pnpm exec e2e-rail run --app <app> --full --mode <mode>
```
The exit code is Playwright's. The summary line is the record:
`run-id <id> · kind <full|selected|rerun|shard> · rc <rc> · <ms>ms · failures <n>`, then up to ten
`failed: <file> › <title> [<project>] — <error>` lines. Lines that limit what you may claim:
- `kind full (filtered)` with `filtered: <options> narrow or relax the run; not a verification` — `--project`, or after
  `--` anything outside the allow-list below (a `--grep`/`-G`/file filter, `--ignore-snapshots`, `-u`, `--retries`, an
  option e2e-rail does not know), narrowed or relaxed the run.
- `shadowed: a selected run does not replace a full run while trust=shadow`.
- `<app>: nothing selected (partial, 0 specs)` (or `…, <n> spec(s), 0 test-list lines`) — nothing ran, nothing was
  recorded, nothing is verified.
- `failed: test list matched no tests` or `failed: test list line matched no tests: <line>` (stderr:
  `e2e-rail: test list matched no tests — check paths are relative to Playwright rootDir`) — the list ran nothing, or
  some of it did not run (a renamed or deleted spec): rc 1, `FAILED`. Select again before you run again. On
  Playwright 1.56–1.57 a test whose title holds `›` or a line break, starts or ends with whitespace, or is empty fails
  this way every time (a list line cannot spell it): report it and recommend Playwright ≥ 1.58.
- `<app>: selection <id> runs this app in full (…); running the full suite` — the run is `kind full`.
- `selection <old> was for other code — reselected as <new>` (or `… was made up to <head>, not HEAD — …`, or
  `… left out uncommitted work in a tree that is not clean — …`) — files changed after `select`, it was made up to
  another head, or it left out uncommitted work; the run used the new selection (its `--add`s carried over, not its
  `--remove`s). Put the new id and its specs in the selection block.
- `e2e-rail: the code changed while waiting for the lock (selection <id> no longer matches); run it again` — nothing
  ran or was recorded.
- `e2e-rail: <build command> failed (rc <n>); Playwright was not started.` — nothing ran or was recorded.
- `last-green not moved: the working tree had uncommitted changes` — the pass verifies this exact code, not HEAD.

Run-shaping options never go after `--`. Only `--shard`, `--test-list`, `--last-failed` and `--project` have e2e-rail
flags (use those); `--reporter`, `--config`, `--list`, `--only-changed`, `--output`, `--test-list-invert`,
`--last-failed-file`, `--ui`, `--debug` and `--run-agents` are not supported at all. The CLI refuses each of them after
`--` before anything runs, except `--project`, which there makes the run `filtered`. After `--` only `--headed`,
`--quiet`, `--trace <mode>`, `--repeat-each <n>`, `--fail-on-flaky-tests`, `--forbid-only`, `--fully-parallel`,
`--max-failures <n>`, `-x` and `-j`/`--workers <n>` keep a run a verification; anything else makes it `filtered`.
Full and shard runs, and runs without a worker count, take the machine-wide exclusive lock;
`waiting for the heavy lock (…)` on stderr means another run holds it. Wait; do not kill and retry.

## 2. Verify (always, in the run's mode)
```sh
pnpm exec e2e-rail verify --app <app> --mode <mode> --require full
```
- exit 0 `verified: full@<run-id> …` / `verified: shards×<n>@<run-id> …` — a full pass of this code.
- exit 20 `stale: …` — no passing run for this code: `differing: <fields>` names what moved since the last full pass,
  `nothing verified yet` means nothing ever passed, `no full pass of a committed tree yet` means every pass had
  uncommitted changes, `dist: not built` means the preview dist is missing. Not a pass.
- exit 21 `insufficient: this code has only <kinds> run(s); --require full needs …` — expected after a selected run.
  With `--require selected`, `insufficient: the selection's list changed since run <id> (select --add/--remove); run
  --selection again` (or `the selection run <id> was made up to a head other than the one it ran` / `… left out
  uncommitted work the run included`) means that run's selection does not vouch for it: run --selection again.

After a selected run you may also quote `verify --app <app> --mode <mode> --require selected`
(`verified: selected@<run-id> (selection <selection-id>, shadowed) (<age>)`; `, shadowed` only while trust is shadow),
but the status stays "selected", never "full pass". Only a run made by `run --selection` from a selection computed
for that very code, of the list that selection writes now, counts there: after a `select --add`, run again. An
ad-hoc `--test-list` run or a `measure workers` run leaves `insufficient:`.

## 3. Report (fixed format)
```
E2E <app> (<mode>)
run:      run-id <id> · kind <kind> · rc <rc> · <duration> · failures <n>
failures: <file> › <title> [<project>] (one per line) | none
verify:   <the verify line, verbatim> (exit <code>)
status:   <one of the statuses below>
```
Statuses, exactly one:
- `full pass` — only when `verify --require full` printed `verified:` in the run's mode.
- `selected run — shadowed, not a full verification` — a selected run while `shadow status` prints `trust shadow`.
- `selected run (trust selected)` — a selected run after a human promoted.
- `FAILED` — rc other than 0.
- `not verified` — `verify` (`--require full` for a full or shard run, `--require selected` for a selected run) did
  not print `verified:` for the run you report.
- `filtered run, not a full verification` · `diagnostic rerun only` · `nothing selected`.

When several apply, the first of these wins: `FAILED`; then not verified (`not verified`, `nothing selected`,
`diagnostic rerun only`); then `filtered run, not a full verification` or `selected run — shadowed, not a full
verification`; then the verified ones, `full pass` and `selected run (trust selected)`.

A selected run also carries the selection block from `e2e-rail:select` and says where the pending full run happens.

## 4. On failure
1. Diagnose with the failed tests only:
   ```sh
   pnpm exec e2e-rail run --app <app> --last-failed --mode <mode>
   ```
   `--last-failed` is a diagnostic (`kind rerun`). It is **never** reported as a pass, never as a full pass, and never
   satisfies `verify --require full`. Report it as `rerun <run-id>: <one-line cause>`.
2. Fix, then run again — `run --full`, or re-select and `run --selection` — and verify. Only that run and its verify
   line go into the report.
3. A failure you did not fix is reported with its `failed:` lines and run-id. Never call a red run green because the
   failure "looks unrelated"; name it and leave the status `FAILED`.
