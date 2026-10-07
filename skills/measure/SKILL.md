---
name: measure
description: Use when the E2E suite feels slow or flaky — long gate times, timeouts, retries, picking a worker count, or deciding whether and how to shard across CI jobs. Reads durations and retry rates from the e2e-rail ledger, separates where a slow spec spends its time, compares worker counts on this machine and plans shards. Do NOT load for: deciding a change's scope (select), running and reporting the gate (gate), first-time setup (init), shadow pairing or promotion (shadow).
---

# e2e-rail:measure — find the slow part, then decide workers and shards

From the repository root; `--app <app>` when the config has several apps. npm or yarn repos: `npx e2e-rail`.
e2e-rail never picks a worker count or a shard count by itself: it measures, a human decides.

## 1. Slowest specs and retries
```sh
pnpm exec e2e-rail measure --app <app> slowest -n 20
pnpm exec e2e-rail measure --app <app> retries --last 10
```
Both read whole-suite runs from the ledger (an unfiltered `run --full` or a complete shard set): the latest one for
`slowest`, the last N for `retries`. `no whole-suite run of app <app> in the ledger yet` → run the full suite through
`e2e-rail:gate` first. Tables: `file  project  duration` and `file  project  runs  retried  rate`.

## 2. Where a slow spec spends its time
For each of the top three, trace one spec. Put its test-list line in a file under `.e2e-rail/` (the ledger dir — a
new file anywhere else in the work tree changes the code fingerprint and stales every earlier run). Copy the line from
`.e2e-rail/test-list.<app>.txt` or a shard list; the format is `[<project>] › <path from Playwright's rootDir>`. With
neither at hand, `pnpm exec e2e-rail shard plan --app <app> --count 1` writes every test's line to
`.e2e-rail/shards/<app>/1.txt` (it replaces an earlier plan's lists).
```sh
pnpm exec e2e-rail run --app <app> --test-list .e2e-rail/trace.txt -- --trace on
pnpm exec playwright show-trace <app root>/test-results/<test dir>/trace.zip
```
That run is `kind selected` and a diagnostic, never a gate result. Split the spec's time into page entry (navigation,
bundle load, first render), response waits (API calls, mocks, `waitFor…`) and repeated setup (login, fixtures, data
built per test). Name the largest with its seconds.

## 3. Worker count
```sh
pnpm exec e2e-rail measure --app <app> workers 1,2,4 --test-list .e2e-rail/test-list.<app>.txt --mode <mode>
```
Use a list of a few minutes (a selection's test list, or one shard list). The same list runs once per count, each
under the machine-wide exclusive lock (it waits for other runs; they wait for it). Table:
`workers  rc  duration  failures  retried  load`. Propose the fastest count with rc 0 and no extra failures or
retries — past that point more workers make runs slower and time out. A human writes it into `run.workers` (`local`,
`ci`) of `e2e-rail.config.mjs`; the command changes nothing.

## 4. Still too long: shards
Native split — each CI job runs 1/N of the suite, no plan needed:
```sh
pnpm exec e2e-rail run --app <app> --full --shard 1/4 --blob --mode <mode>
```
Planned split — balanced by measured durations (`--from-run <run-id>` picks the run to weigh by):
```sh
pnpm exec e2e-rail shard plan --app <app> --count 4
pnpm exec e2e-rail run --app <app> --test-list .e2e-rail/shards/<app>/1.txt --shard 1/4 --blob --mode <mode>
```
The plan writes `.e2e-rail/shards/<app>/<i>.txt` and `manifest.json` and prints `shard <i>/<n> · ~<estimate> · …`.
List i must run unedited as `--shard i/<count>` of that plan; anything else is refused before it runs.
`--include e2e/<spec>.spec.ts` makes the plan fail unless Playwright lists that spec.

Merge the blob reports and see whether the shards add up to a full verification of this code:
```sh
pnpm exec e2e-rail shard merge --app <app> --dir <blob reports dir> --mode <mode>
```
`complete: yes (verify counts the shard set as a full run)` only when every list of ONE plan, or every native i/N,
passed on this exact code. CI templates for both forms: `node_modules/e2e-rail/templates/ci/`.

## 5. Report
```
measure <app>
slowest:  <top 5: spec [project] duration>
retries:  <specs with a rate above 0%> | none
time:     <spec> — <page entry | response waits | repeated setup> <seconds> (trace run-id <id>)
workers:  <count → duration · failures · retried, per row> — proposed run.workers.<local|ci> = <n> (a human sets it)
shards:   not needed | plan <planId>: <n> lists, ~<estimate> each | native <n>
```
