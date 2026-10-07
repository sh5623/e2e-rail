# e2e-rail

> Change-aware Playwright E2E: select only the specs a change can reach, record every run against a code fingerprint so a stale green is never reused, and shard by measured durations. Runtime-agnostic CLI with Claude Code and Codex skill layers.

**Status: design complete, implementation not started.** Start here:

| Document | What it holds |
| --- | --- |
| [`docs/superpowers/specs/2026-10-07-e2e-rail-design.md`](docs/superpowers/specs/2026-10-07-e2e-rail-design.md) | The design: scope, distribution (npm + Claude plugin + Codex package), config schema, spec index, graph + adapters, selection rules, fingerprint + ledger, verify + shadow mode, run/lock/workers/shards, skills/agent/hook, test strategy, first rollout, known limits |
| [`docs/superpowers/plans/2026-10-07-e2e-rail-implementation.md`](docs/superpowers/plans/2026-10-07-e2e-rail-implementation.md) | Implementation plan part 1 — Tasks 1–9: scaffold, utils, config, host tools, fixture, spec index, adapters, graph, selector |
| [`docs/superpowers/plans/2026-10-07-e2e-rail-implementation-part2.md`](docs/superpowers/plans/2026-10-07-e2e-rail-implementation-part2.md) | Part 2 — Tasks 10–17: fingerprint, ledger, run + lock, verify + shadow, measure + shard, CLI, plugin layer (Claude + Codex), contract test, release, marketplace listing |

## Install (once v0.1.0 ships)

```sh
pnpm add -D github:sh5623/e2e-rail#v0.1.0        # the CLI every runtime and CI calls
```
```text
/plugin marketplace add sh5623/guardrail           # Claude Code
/plugin install e2e-rail@guardrail
```
```sh
codex plugin marketplace add https://github.com/sh5623/e2e-rail.git   # Codex
codex plugin add e2e-rail@e2e-rail-codex
```

## License

MIT © 2026 Seungho
