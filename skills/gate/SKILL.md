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
- `kind full (filtered)` with `filtered: …` — `--project` or a `-- --grep`/file filter narrowed the run.
- `shadowed: a selected run does not replace a full run while trust=shadow`.
- `<app>: nothing selected (partial, 0 specs)` — nothing ran, nothing was recorded, nothing is verified.
- `<app>: selection <id> runs this app in full (…); running the full suite` — the run is `kind full`.
- `e2e-rail: warning: selection <id> was computed for other code …` — select again before you rely on it.
- `e2e-rail: <build command> failed (rc <n>); Playwright was not started.` — nothing ran or was recorded.

Run-shaping options never go after `--` (`--shard`, `--test-list`, `--last-failed`, `--reporter`, `--config`,
`--list`, `--only-changed`): the CLI refuses them before running; use its own flags. Full and shard runs, and runs
without a worker count, take the machine-wide exclusive lock; `waiting for the heavy lock (…)` on stderr means another
run holds it. Wait; do not kill and retry.

## 2. Verify (always, in the run's mode)
```sh
pnpm exec e2e-rail verify --app <app> --mode <mode> --require full
```
- exit 0 `verified: full@<run-id> …` / `verified: shards×<n>@<run-id> …` — a full pass of this code.
- exit 20 `stale: …` — no passing run for this code: `differing: <fields>` names what moved since the last full pass,
  `nothing verified yet` means nothing ever passed, `dist: not built` means the preview dist is missing. Not a pass.
- exit 21 `insufficient: this code has only <kinds> run(s); --require full needs …` — expected after a selected run.

After a selected run you may also quote `verify --app <app> --mode <mode> --require selected`
(`verified: selected@<run-id>`), but the status stays "selected", never "full pass".

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
- `filtered run, not a full verification` · `diagnostic rerun only` · `nothing selected`.

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
