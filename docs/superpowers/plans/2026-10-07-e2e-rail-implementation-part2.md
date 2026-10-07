# e2e-rail 구현 계획 (2부: 지문 · 원장 · 실행 · 검증 · 분산 · 런타임 층 · 릴리스)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1부의 선택기 위에 «무엇을 검증했는가» 원장, Playwright 실행 래퍼, 섀도·승격, 측정·분산, CLI, Claude/Codex 플러그인 층을 얹어 v0.1.0 을 릴리스한다.

**Architecture:** 모든 실행은 `fingerprint`(코드 지문)와 함께 `.e2e-rail/ledger.jsonl` 에 1줄로 남고, `verify` 는 현재 지문과 원장만 보고 판정한다. `run` 은 `node <playwright cli> test …` 를 spawn 하고 JSON 리포터를 파싱한다. 락은 tmpdir 의 mkdir 원자성에 기댄다. 플러그인 층은 CLI 를 호출하는 문서(스킬)다.

**Tech Stack:** 1부와 동일. 추가 없음.

**Spec:** `docs/superpowers/specs/2026-10-07-e2e-rail-design.md` §7~§13.

**1부:** `docs/superpowers/plans/2026-10-07-e2e-rail-implementation.md` — Global Constraints · Review Focus · Task 1~9 의 Interfaces 는 거기 있고 이 문서는 그 이름을 그대로 쓴다.

## Global Constraints

1부와 동일. 추가로:
- `run` 은 Playwright 인자를 **그대로 통과**시킨다. 플러그인이 아는 옵션만 해석하고 나머지는 `--` 뒤로 넘긴다.
- 원장 줄의 `kind` 는 `full | selected | rerun | shard` 넷뿐이며 `--last-failed` 가 있으면 무조건 `rerun` 이다.
- `verify --require full` 은 `rerun`·`selected` 로 절대 만족되지 않는다. 이 두 규칙을 깨는 코드는 리뷰에서 반려한다.

## Review Focus

1. **preview 모드에서 `dist` 가 없거나 src 보다 오래됨** → `run` 이 빌드 명령을 먼저 돌리고, `--no-build` 면 종료 1 과 메시지. (Task 12 테스트)
2. **원장 파일이 손상된 줄(깨진 JSON)을 포함** → `readRuns` 는 그 줄만 건너뛰고 경고를 내야 한다. 전체가 죽으면 `verify` 가 매번 실패해 전수로 몰린다. (Task 11 테스트)
3. **섀도 record 에 짝이 되는 selection 이 없음**(선택 없이 전수만 돌린 라운드) → `trivial` 도 아니고 오류도 아닌 `unpaired` 로 기록하고 streak 를 건드리지 않는다. (Task 13 테스트)
4. **락 보유 프로세스가 죽은 뒤 남은 디렉터리** → `acquire` 가 영원히 기다리면 안 된다. 획득 루프가 고아 락을 reap 한다. (Task 12 락 테스트)
5. **`shard plan` 에 시간 정보가 없는 spec**(새 spec) → 중앙값으로 가정하고 manifest 에 `estimated: true` 를 찍는다. (Task 14 테스트)

---

### Task 10: 지문 `fingerprint.mjs`

**Files:**
- Create: `src/fingerprint.mjs`
- Test: `test/fingerprint.test.mjs`

**Interfaces:**
- Produces: `computeFingerprint({ config, app, mode }) => { id, codeId, head, diff, untracked, config: string, playwright: string, dist: string|null }` · `distStale({ config, app }) => boolean` · `distHash({ config, app }) => string|null` · `maxMtime(abs) => number`(재귀 · 없으면 0).

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/fingerprint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { computeFingerprint, distStale } from '../src/fingerprint.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { makeTempRepo } from './helpers.mjs';

test('id changes with uncommitted edit, untracked file and dist; codeId ignores dist', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const a = computeFingerprint({ config, app, mode: 'dev' });
    assert.equal(a.dist, null); assert.equal(a.playwright, '1.61.0');
    writeFileSync(path.join(root, 'src/main.ts'), '// e\n', { flag: 'a' });
    const b = computeFingerprint({ config, app, mode: 'dev' });
    assert.notEqual(a.id, b.id); assert.notEqual(a.codeId, b.codeId);
    writeFileSync(path.join(root, 'src/new.ts'), 'export {}\n');
    const c = computeFingerprint({ config, app, mode: 'dev' });
    assert.notEqual(b.id, c.id);
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), '1');
    const d = computeFingerprint({ config, app, mode: 'preview' });
    assert.ok(d.dist); assert.notEqual(c.id, d.id); assert.equal(c.codeId, d.codeId);
  } finally { cleanup(); }
});

test('distStale: missing dist, older dist, fresh dist', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    assert.equal(distStale({ config, app }), true);
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), '1');
    const old = new Date(Date.now() - 60_000); utimesSync(path.join(root, 'dist/index.html'), old, old);
    assert.equal(distStale({ config, app }), true);
    const now = new Date(Date.now() + 1_000); utimesSync(path.join(root, 'dist/index.html'), now, now);
    assert.equal(distStale({ config, app }), false);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/fingerprint.test.mjs` → FAIL

- [ ] **Step 3: 구현**

```js
// src/fingerprint.mjs
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { appDir, CONFIG_FILE } from './config.mjs';
import { sha256, hashFiles } from './util/hash.mjs';
import { walk } from './util/glob.mjs';
import { gitHead, gitDiffHash, gitUntrackedHash } from './util/git.mjs';
import { playwrightVersion } from './util/playwright.mjs';

export function maxMtime(abs) {
  if (!existsSync(abs)) return 0;
  const st = statSync(abs);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  for (const rel of walk(abs)) m = Math.max(m, statSync(path.join(abs, rel)).mtimeMs);
  return m;
}
export function distHash({ config, app }) {
  if (!app.run.preview) return null;
  const distAbs = path.join(appDir(config, app), app.run.preview.dist);
  if (!existsSync(distAbs)) return null;
  return hashFiles(distAbs, walk(distAbs));
}
export function distStale({ config, app }) {
  if (!app.run.preview) return false;
  const dirAbs = appDir(config, app);
  const distAbs = path.join(dirAbs, app.run.preview.dist);
  if (!existsSync(distAbs)) return true;
  const srcM = Math.max(maxMtime(path.join(dirAbs, app.srcDir)), maxMtime(path.join(dirAbs, 'index.html')), maxMtime(path.join(dirAbs, 'package.json')));
  return srcM > maxMtime(distAbs);
}
export function computeFingerprint({ config, app, mode }) {
  const dirAbs = appDir(config, app);
  const head = gitHead(config.root); const diff = gitDiffHash(config.root); const untracked = gitUntrackedHash(config.root);
  const cfg = sha256(readFileSync(path.join(dirAbs, app.playwrightConfig), 'utf8') + readFileSync(path.join(config.root, CONFIG_FILE), 'utf8'));
  const playwright = playwrightVersion(dirAbs);
  const dist = mode === 'preview' ? distHash({ config, app }) : null;
  const codeId = sha256(`${head}\n${diff}\n${untracked}`);
  const id = sha256(JSON.stringify({ head, diff, untracked, cfg, playwright, dist }));
  return { id, codeId, head, diff, untracked, config: cfg, playwright, dist };
}
```

- [ ] **Step 4: 통과 확인** → `node --test test/fingerprint.test.mjs` PASS 2
- [ ] **Step 5: 커밋** → `git commit -am "feat(fingerprint): code/config/dist fingerprint and dist staleness"`

---

### Task 11: 원장 `ledger.mjs`

**Files:**
- Create: `src/ledger.mjs`
- Test: `test/ledger.test.mjs`

**Interfaces:**
- Produces: `ledgerPath(config) => abs` · `appendRun(config, entry) => entry`(`id`·`ts` 가 없으면 채움) · `readRuns(config, { app? } = {}) => entry[]`(깨진 줄은 `console.warn` 후 건너뜀) · `latestFull(runs, app, fpId) => entry|null` · `completeShardSet(runs, app, fpId) => entry[]|null`(같은 `fingerprint.id` 의 `kind:'shard'` 가 `shard.count` 개 모두 rc 0 이면 그 배열) · `writeLastGreen(config, app, head)` · `readLastGreen(config, app) => string|null`.
- 원장 줄 스키마는 스펙 §7 그대로.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { appendRun, readRuns, ledgerPath, latestFull, completeShardSet, writeLastGreen, readLastGreen } from '../src/ledger.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempRepo } from './helpers.mjs';

const fp = (id) => ({ id, codeId: `c-${id}`, head: 'h', diff: 'd', untracked: 'u', config: 'c', playwright: '1.61.0', dist: null });

test('append is one JSON line, read skips corrupt lines, helpers find full and shard sets', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root);
    const e = appendRun(config, { app: 'web', kind: 'full', mode: 'dev', fingerprint: fp('A'), rc: 0, durationMs: 10, specs: [], failures: [], flaky: [] });
    assert.match(e.id, /^run-/); assert.ok(e.ts);
    appendFileSync(ledgerPath(config), '{not json\n');
    appendRun(config, { app: 'web', kind: 'shard', shard: { index: 1, count: 2 }, mode: 'dev', fingerprint: fp('B'), rc: 0, durationMs: 1, specs: [], failures: [], flaky: [] });
    appendRun(config, { app: 'web', kind: 'shard', shard: { index: 2, count: 2 }, mode: 'dev', fingerprint: fp('B'), rc: 0, durationMs: 1, specs: [], failures: [], flaky: [] });
    appendRun(config, { app: 'web', kind: 'rerun', mode: 'dev', fingerprint: fp('A'), rc: 0, durationMs: 1, specs: [], failures: [], flaky: [] });
    const runs = readRuns(config, { app: 'web' });
    assert.equal(runs.length, 4);
    assert.equal(readFileSync(ledgerPath(config), 'utf8').split('\n').filter(Boolean).length, 5);
    assert.equal(latestFull(runs, 'web', 'A').id, e.id);
    assert.equal(latestFull(runs, 'web', 'B'), null);
    assert.equal(completeShardSet(runs, 'web', 'B').length, 2);
    assert.equal(completeShardSet(runs, 'web', 'A'), null);
    writeLastGreen(config, 'web', 'abc123'); assert.equal(readLastGreen(config, 'web'), 'abc123');
    assert.equal(readLastGreen(config, 'other'), null);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**

```js
// src/ledger.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './config.mjs';
import { newId } from './select.mjs';

export const ledgerPath = (config) => path.join(ledgerDir(config), 'ledger.jsonl');
export function appendRun(config, entry) {
  const full = { id: entry.id ?? newId('run'), ts: entry.ts ?? new Date().toISOString(), ...entry };
  mkdirSync(ledgerDir(config), { recursive: true });
  appendFileSync(ledgerPath(config), `${JSON.stringify(full)}\n`);
  return full;
}
export function readRuns(config, { app } = {}) {
  const abs = ledgerPath(config);
  if (!existsSync(abs)) return [];
  const out = [];
  readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { const e = JSON.parse(line); if (!app || e.app === app) out.push(e); }
    catch { console.warn(`ledger: skipping corrupt line ${i + 1}`); }
  });
  return out;
}
export function latestFull(runs, app, fpId) {
  return [...runs].reverse().find((r) => r.app === app && r.kind === 'full' && r.rc === 0 && r.fingerprint?.id === fpId) ?? null;
}
export function completeShardSet(runs, app, fpId) {
  const shards = runs.filter((r) => r.app === app && r.kind === 'shard' && r.rc === 0 && r.fingerprint?.id === fpId && r.shard);
  if (!shards.length) return null;
  const count = shards[0].shard.count;
  const byIndex = new Map(shards.map((s) => [s.shard.index, s]));
  for (let i = 1; i <= count; i++) if (!byIndex.has(i)) return null;
  return [...byIndex.values()];
}
const lastGreenPath = (config, app) => path.join(ledgerDir(config), `last-green.${app}`);
export function writeLastGreen(config, app, head) { mkdirSync(ledgerDir(config), { recursive: true }); writeFileSync(lastGreenPath(config, app), `${head}\n`); }
export function readLastGreen(config, app) { const p = lastGreenPath(config, app); return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; }
```

- [ ] **Step 4: 통과 확인** → PASS 1
- [ ] **Step 5: 커밋** → `git commit -am "feat(ledger): append-only run ledger with corrupt-line tolerance and last-green marker"`

---

### Task 12: 실행 래퍼 `run.mjs` 와 락 `lock.mjs`

**Files:**
- Create: `src/lock.mjs`, `src/run.mjs`
- Test: `test/lock.test.mjs`, `test/run.test.mjs`

**Interfaces:**
- Produces:
  - `lockDir(config) => abs`(`os.tmpdir()/e2e-rail-lock/<sha256(root).slice(0,12)>`) · `acquire({ dir, cls: 'heavy'|'light', slots = 2, pollMs = 500, timeoutMs = Infinity, purpose }) => Promise<{ release(), waitMs, loadAtStart }>` · `reap(dir) => string[]`(지운 락) · `lockStatus(dir) => { heavy: owner|null, light: owner[] }` · `isHeavyShape(args: string[]) => boolean`(`--workers` 없음 · `--test-list` 없음 · `--shard` 있음 중 하나면 heavy)
  - `parsePlaywrightReport(report, appDirAbs) => { specs: [{file, project, status, durationMs, retries}], failures: [{file, title, project, error}], flaky: [{file, project}] }`
  - `runTests({ config, app, kind, mode = 'dev', testList = null, lastFailed = false, workers, project, shard = null, blob = false, lock = true, build = true, selectionId = null, passthrough = [] }) => Promise<{ rc, entry }>`
  - `kindOf({ lastFailed, shard, testList }) => 'rerun'|'shard'|'selected'|'full'`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/lock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquire, reap, lockStatus, isHeavyShape } from '../src/lock.mjs';

test('heavy excludes light; light slots are shared; release frees', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
  try {
    const h = await acquire({ dir, cls: 'heavy', pollMs: 20, purpose: 'full' });
    let lightGot = false;
    const p = acquire({ dir, cls: 'light', pollMs: 20, purpose: 'unit' }).then((l) => { lightGot = true; return l; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(lightGot, false);
    h.release();
    const l = await p; assert.equal(lightGot, true);
    const l2 = await acquire({ dir, cls: 'light', pollMs: 20 });
    assert.equal(lockStatus(dir).light.length, 2);
    l.release(); l2.release();
    assert.equal(lockStatus(dir).light.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan lock (dead pid) is reaped so acquire does not hang', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
  try {
    mkdirSync(path.join(dir, 'heavy.lock'));
    writeFileSync(path.join(dir, 'heavy.lock/owner.json'), JSON.stringify({ pid: 999999, cls: 'heavy', purpose: 'ghost', start: new Date().toISOString() }));
    const h = await acquire({ dir, cls: 'heavy', pollMs: 20, timeoutMs: 2000 });
    h.release();
    assert.deepEqual(reap(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isHeavyShape', () => {
  assert.equal(isHeavyShape(['test']), true);
  assert.equal(isHeavyShape(['test', '--workers', '2', '--test-list', 'x']), false);
  assert.equal(isHeavyShape(['test', '--workers', '2']), true);
  assert.equal(isHeavyShape(['test', '--shard', '1/2', '--workers', '1', '--test-list', 'x']), true);
});
```

```js
// test/run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runTests, parsePlaywrightReport, kindOf } from '../src/run.mjs';
import { readRuns } from '../src/ledger.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { makeTempRepo, readJson, fixtureDir } from './helpers.mjs';

test('parsePlaywrightReport aggregates per file/project with failures and flaky', () => {
  const app = fixtureDir('sample-app');
  const r = parsePlaywrightReport(readJson(path.join(app, 'stub/report-fail.json')), app);
  const orders = r.specs.find((s) => s.file === 'e2e/orders.spec.ts');
  assert.equal(orders.status, 'failed'); assert.equal(orders.retries, 1); assert.equal(orders.durationMs, 5900);
  assert.equal(r.failures[0].file, 'e2e/orders.spec.ts'); assert.equal(r.failures[0].error, 'expect(received).toBeVisible()');
  assert.deepEqual(r.flaky, [{ file: 'e2e/cart.spec.ts', project: 'chromium' }]);
});

test('kindOf', () => {
  assert.equal(kindOf({ lastFailed: true, shard: { index: 1, count: 2 }, testList: 'x' }), 'rerun');
  assert.equal(kindOf({ shard: { index: 1, count: 2 } }), 'shard');
  assert.equal(kindOf({ testList: 'x' }), 'selected');
  assert.equal(kindOf({}), 'full');
});

test('runTests spawns playwright with test-list + reporters, writes a ledger line, returns rc', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const argvFile = path.join(root, 'argv.json');
    process.env.STUB_PW_ARGV_FILE = argvFile;
    mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
    writeFileSync(path.join(root, '.e2e-rail/test-list.web.txt'), '[chromium] › e2e/orders.spec.ts\n');
    const { rc, entry } = await runTests({ config, app, kind: 'selected', testList: path.join(root, '.e2e-rail/test-list.web.txt'), workers: 2, lock: false, selectionId: 'sel-x' });
    assert.equal(rc, 0);
    const argv = readJson(argvFile);
    assert.ok(argv.includes('--test-list') && argv.includes('--workers') && argv.some((a) => a.startsWith('--reporter=list,json')));
    assert.equal(entry.kind, 'selected'); assert.equal(entry.selectionId, 'sel-x'); assert.equal(entry.specs.length, 5);
    assert.equal(readRuns(config)[0].id, entry.id);
    process.env.STUB_PW_RC = '1'; process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json');
    const failed = await runTests({ config, app, kind: 'full', lock: false });
    assert.equal(failed.rc, 1); assert.equal(failed.entry.failures.length, 1);
    assert.equal(existsSync(path.join(root, '.e2e-rail/last-green.web')), false);
  } finally { delete process.env.STUB_PW_RC; delete process.env.STUB_PW_REPORT; delete process.env.STUB_PW_ARGV_FILE; cleanup(); }
});

test('preview mode builds when dist is stale and records dist hash; --no-build refuses', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const r = await runTests({ config, app, kind: 'full', mode: 'preview', lock: false });
    assert.equal(r.rc, 0); assert.ok(existsSync(path.join(root, 'dist/index.html'))); assert.ok(r.entry.fingerprint.dist);
    assert.equal(readFileSync(path.join(root, '.e2e-rail/last-green.web'), 'utf8').trim().length, 40);
    writeFileSync(path.join(root, 'src/main.ts'), '// touch\n', { flag: 'a' });
    const now = new Date(Date.now() + 5000); const { utimesSync } = await import('node:fs'); utimesSync(path.join(root, 'src/main.ts'), now, now);
    const refused = await runTests({ config, app, kind: 'full', mode: 'preview', lock: false, build: false });
    assert.equal(refused.rc, 1); assert.equal(refused.entry, null);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인** → FAIL 둘 다
- [ ] **Step 3: 구현**

```js
// src/lock.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from './util/hash.mjs';

export const lockDir = (config) => path.join(tmpdir(), 'e2e-rail-lock', sha256(config.root).slice(0, 12));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const owner = (abs) => { try { return JSON.parse(readFileSync(path.join(abs, 'owner.json'), 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reap(dir) {
  const removed = [];
  if (!existsSync(dir)) return removed;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.lock')) continue;
    const abs = path.join(dir, name); const o = owner(abs);
    if (!o || !alive(o.pid)) { rmSync(abs, { recursive: true, force: true }); removed.push(name); }
  }
  return removed;
}
export function lockStatus(dir) {
  const st = { heavy: null, light: [] };
  if (!existsSync(dir)) return st;
  for (const name of readdirSync(dir)) {
    if (name === 'heavy.lock') st.heavy = owner(path.join(dir, name));
    else if (name.startsWith('light-') && name.endsWith('.lock')) { const o = owner(path.join(dir, name)); if (o) st.light.push(o); }
  }
  return st;
}
function tryTake(abs, cls, purpose) {
  try { mkdirSync(abs); } catch { return false; }
  writeFileSync(path.join(abs, 'owner.json'), JSON.stringify({ pid: process.pid, cls, purpose, cwd: process.cwd(), start: new Date().toISOString() }));
  return true;
}
export async function acquire({ dir, cls, slots = 2, pollMs = 500, timeoutMs = Infinity, purpose = '' }) {
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    reap(dir);
    if (cls === 'heavy') {
      const abs = path.join(dir, 'heavy.lock');
      if (tryTake(abs, cls, purpose)) {
        while (lockStatus(dir).light.length) { if (Date.now() - t0 > timeoutMs) { rmSync(abs, { recursive: true, force: true }); throw new Error('lock timeout (heavy waiting for light)'); } await sleep(pollMs); reap(dir); }
        return done(abs);
      }
    } else if (!existsSync(path.join(dir, 'heavy.lock'))) {
      for (let i = 0; i < slots; i++) { const abs = path.join(dir, `light-${i}.lock`); if (tryTake(abs, cls, purpose)) return done(abs); }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`lock timeout (${cls})`);
    await sleep(pollMs);
  }
  function done(abs) {
    const release = () => rmSync(abs, { recursive: true, force: true });
    process.once('exit', release);
    return { release, waitMs: Date.now() - t0, loadAtStart: Number(loadavg()[0].toFixed(2)) };
  }
}
export function isHeavyShape(args) {
  if (args.includes('--shard')) return true;
  if (!args.includes('--workers')) return true;
  if (!args.includes('--test-list')) return true;
  return false;
}
```

```js
// src/run.mjs
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { computeFingerprint, distStale } from './fingerprint.mjs';
import { appendRun, writeLastGreen } from './ledger.mjs';
import { acquire, lockDir } from './lock.mjs';
import { execCapture, execInherit } from './util/exec.mjs';
import { playwrightCli, flattenSuites } from './util/playwright.mjs';
import { newId } from './select.mjs';

export function kindOf({ lastFailed, shard, testList }) {
  if (lastFailed) return 'rerun';
  if (shard) return 'shard';
  if (testList) return 'selected';
  return 'full';
}
export function parsePlaywrightReport(report, appDirAbs) {
  const specs = new Map(); const failures = []; const flaky = [];
  for (const t of flattenSuites(report, appDirAbs)) {
    const key = `${t.file}::${t.project}`;
    const cur = specs.get(key) ?? { file: t.file, project: t.project, status: 'passed', durationMs: 0, retries: 0 };
    cur.durationMs += t.results.reduce((s, r) => s + (r.duration ?? 0), 0);
    cur.retries = Math.max(cur.retries, Math.max(0, t.results.length - 1));
    if (t.status === 'unexpected') { cur.status = 'failed'; failures.push({ file: t.file, title: t.title, project: t.project, error: (t.results.at(-1)?.error?.message ?? '').split('\n')[0] }); }
    else if (t.status === 'flaky') { if (!flaky.some((f) => f.file === t.file && f.project === t.project)) flaky.push({ file: t.file, project: t.project }); }
    else if (t.status === 'skipped' && cur.status === 'passed' && cur.durationMs === 0) cur.status = 'skipped';
    specs.set(key, cur);
  }
  return { specs: [...specs.values()].sort((a, b) => a.file.localeCompare(b.file) || a.project.localeCompare(b.project)), failures, flaky };
}
export async function runTests({ config, app, kind, mode = 'dev', testList = null, lastFailed = false, workers, project, shard = null, blob = false, lock = true, build = true, selectionId = null, passthrough = [] }) {
  const dirAbs = appDir(config, app);
  kind = kindOf({ lastFailed, shard, testList }) === 'rerun' ? 'rerun' : (kind ?? kindOf({ lastFailed, shard, testList }));
  if (mode === 'preview' && app.run.preview && distStale({ config, app })) {
    if (!build) { console.error(`dist (${app.run.preview.dist}) is older than src. Run \`${app.run.preview.build}\` or drop --no-build.`); return { rc: 1, entry: null }; }
    const [cmd, ...args] = app.run.preview.build.split(' ');
    const b = await execInherit(cmd, args, { cwd: config.root });
    if (b.status !== 0) { console.error('build failed'); return { rc: b.status, entry: null }; }
  }
  const fingerprint = computeFingerprint({ config, app, mode });
  const id = newId('run');
  const reportAbs = path.join(ledgerDir(config), 'reports', `${id}.json`);
  mkdirSync(path.dirname(reportAbs), { recursive: true });
  const args = ['test', '--config', app.playwrightConfig];
  if (testList) args.push('--test-list', testList);
  if (lastFailed) args.push('--last-failed');
  if (workers != null) args.push('--workers', String(workers));
  if (project) args.push('--project', project);
  if (shard) args.push('--shard', `${shard.index}/${shard.count}`);
  args.push(`--reporter=${blob ? 'blob,json' : 'list,json'}`);
  args.push(...passthrough);
  const env = { ...app.run.env, ...(app.run.modeEnv[mode] ?? {}), PLAYWRIGHT_JSON_OUTPUT_NAME: reportAbs };
  const cls = kind === 'full' || kind === 'shard' ? 'heavy' : 'light';
  const held = lock ? await acquire({ dir: lockDir(config), cls, purpose: `${app.name}:${kind}` }) : null;
  const t0 = Date.now();
  let status;
  try { ({ status } = await execInherit('node', [playwrightCli(dirAbs), ...args], { cwd: dirAbs, env })); }
  finally { held?.release(); }
  const report = existsSync(reportAbs) ? JSON.parse(readFileSync(reportAbs, 'utf8')) : { suites: [] };
  const parsed = parsePlaywrightReport(report, dirAbs);
  const entry = appendRun(config, { id, app: app.name, kind, mode, fingerprint, selectionId, shard, workers: workers ?? null, command: `playwright ${args.join(' ')}`, lock: held ? { class: cls, waitMs: held.waitMs, loadAtStart: held.loadAtStart } : null, rc: status, durationMs: Date.now() - t0, ...parsed });
  if (status === 0 && kind === 'full') writeLastGreen(config, app.name, fingerprint.head);
  return { rc: status, entry };
}
```

- [ ] **Step 4: 통과 확인** → `node --test test/lock.test.mjs test/run.test.mjs` PASS 7
- [ ] **Step 5: 커밋** → `git commit -am "feat(run): playwright wrapper with fingerprint, heavy/light lock, JSON report parsing and ledger line"`

---

### Task 13: `verify.mjs` 와 `shadow.mjs`

**Files:**
- Create: `src/verify.mjs`, `src/shadow.mjs`
- Test: `test/verify-shadow.test.mjs`

**Interfaces:**
- Produces:
  - `verify({ config, app, mode = 'dev', require = 'full', maxAgeMin = null }) => { status: 'verified'|'stale'|'insufficient', exitCode: 0|20|21, run?, fingerprint, lastVerifiedHead?: string|null, differing?: string[] }`
  - `statePath(config)` · `readState(config) => { trust: 'shadow'|'selected', streak: number, window: [] }` · `writeState` · `recordShadow({ config, app, runId }) => { fp, hit, trivial, unpaired, missed, removedMissed, streak }` · `shadowStatus(config) => { trust, streak, promoteAfter, promotable, recent: [] }` · `promote(config)` · `demote(config)`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/verify-shadow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { verify } from '../src/verify.mjs';
import { recordShadow, shadowStatus, promote, demote, readState } from '../src/shadow.mjs';
import { runTests } from '../src/run.mjs';
import { computeSelection, writeSelection } from '../src/select.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { makeTempRepo } from './helpers.mjs';

async function setup() { const t = makeTempRepo('sample-app'); const config = await loadConfig(t.root); return { ...t, config, app: findApp(config), ts: await loadTypeScript(t.root) }; }
async function ctx(config, ts) {
  const { loadOrBuildSpecIndex } = await import('../src/spec-index.mjs'); const { loadOrBuildGraph, findMain } = await import('../src/graph.mjs'); const { getAdapter } = await import('../src/adapters/index.mjs');
  return { forApp: async (app) => { const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts }); return { index: await loadOrBuildSpecIndex({ config, app, ts }), graph: await loadOrBuildGraph({ config, app, ts }), entries, unresolvedEntries: unresolved, main: findMain(config, app) }; } };
}

test('verify: verified after full; stale after edit (names differing field); rerun/selected insufficient for full', async () => {
  const { root, config, app, cleanup } = await setup();
  try {
    assert.equal(verify({ config, app }).status, 'stale');
    await runTests({ config, app, kind: 'full', lock: false });
    const v = verify({ config, app }); assert.equal(v.status, 'verified'); assert.equal(v.exitCode, 0);
    writeFileSync(path.join(root, 'src/main.ts'), '// e\n', { flag: 'a' });
    const s = verify({ config, app }); assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['diff']); assert.equal(s.lastVerifiedHead.length, 40);
    await runTests({ config, app, kind: 'selected', testList: path.join(root, 'stub/list.json'), workers: 1, lock: false });
    const i = verify({ config, app }); assert.equal(i.status, 'insufficient'); assert.equal(i.exitCode, 21);
    assert.equal(verify({ config, app, require: 'selected' }).status, 'verified');
    process.env.STUB_PW_RC = '0';
    await runTests({ config, app, kind: 'full', lastFailed: true, lock: false });
    assert.equal(verify({ config, app }).status, 'insufficient');
  } finally { delete process.env.STUB_PW_RC; cleanup(); }
});

test('shadow: hit advances streak, miss resets, trivial/unpaired do not count, promote/demote', async () => {
  const { root, config, app, ts, cleanup } = await setup();
  try {
    assert.equal(readState(config).trust, 'shadow');
    const c = await ctx(config, ts);
    // 짝 없는 전수
    const r0 = await runTests({ config, app, kind: 'full', lock: false });
    assert.equal(recordShadow({ config, app, runId: r0.entry.id }).unpaired, true);
    // partial 선택 + 전수 통과 → hit
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx: c }));
    const r1 = await runTests({ config, app, kind: 'full', lock: false });
    assert.equal(recordShadow({ config, app, runId: r1.entry.id }).hit, true);
    assert.equal(shadowStatus(config).streak, 1);
    // 같은 선택 · 전수에서 orders 실패 → orders 는 선택 안에 있음(Table 소비) → hit
    process.env.STUB_PW_RC = '1'; process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json');
    const r2 = await runTests({ config, app, kind: 'full', lock: false });
    assert.equal(recordShadow({ config, app, runId: r2.entry.id }).hit, true);
    assert.equal(shadowStatus(config).promotable, true);     // promoteAfter = 2
    // 선택이 orders 를 안 담는 경우 → miss
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/features/cart/services/cart.ts'], ctx: c }));
    const r3 = await runTests({ config, app, kind: 'full', lock: false });
    const m = recordShadow({ config, app, runId: r3.entry.id });
    assert.equal(m.hit, false); assert.deepEqual(m.missed, ['e2e/orders.spec.ts']); assert.equal(shadowStatus(config).streak, 0);
    // full 선택은 trivial
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/shell/Header.ts'], ctx: c }));
    const r4 = await runTests({ config, app, kind: 'full', lock: false });
    assert.equal(recordShadow({ config, app, runId: r4.entry.id }).trivial, true);
    promote(config); assert.equal(readState(config).trust, 'selected');
    demote(config); assert.equal(readState(config).trust, 'shadow');
  } finally { delete process.env.STUB_PW_RC; delete process.env.STUB_PW_REPORT; cleanup(); }
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**

```js
// src/verify.mjs
import { computeFingerprint } from './fingerprint.mjs';
import { readRuns, latestFull, completeShardSet } from './ledger.mjs';

const FIELDS = ['head', 'diff', 'untracked', 'config', 'playwright', 'dist'];
export function verify({ config, app, mode = 'dev', require = 'full', maxAgeMin = null }) {
  const fingerprint = computeFingerprint({ config, app, mode });
  const runs = readRuns(config, { app: app.name });
  const fresh = (r) => maxAgeMin == null || Date.now() - Date.parse(r.ts) <= maxAgeMin * 60_000;
  const same = runs.filter((r) => r.rc === 0 && r.fingerprint?.id === fingerprint.id && fresh(r));
  const full = latestFull(same, app.name, fingerprint.id) ?? (completeShardSet(same, app.name, fingerprint.id)?.at(-1) ?? null);
  const selected = [...same].reverse().find((r) => r.kind === 'selected') ?? null;
  const run = require === 'full' ? full : (full ?? selected);
  if (run) return { status: 'verified', exitCode: 0, run, fingerprint };
  if (same.length) return { status: 'insufficient', exitCode: 21, fingerprint, have: same.map((r) => r.kind) };
  const last = [...runs].reverse().find((r) => r.rc === 0 && (r.kind === 'full' || r.kind === 'shard'));
  const differing = last ? FIELDS.filter((f) => last.fingerprint?.[f] !== fingerprint[f]) : FIELDS;
  return { status: 'stale', exitCode: 20, fingerprint, lastVerifiedHead: last?.fingerprint?.head ?? null, differing };
}
```

```js
// src/shadow.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './config.mjs';
import { readRuns } from './ledger.mjs';

export const statePath = (config) => path.join(ledgerDir(config), 'state.json');
export function readState(config) { return existsSync(statePath(config)) ? JSON.parse(readFileSync(statePath(config), 'utf8')) : { trust: 'shadow', streak: 0, window: [] }; }
export function writeState(config, st) { mkdirSync(ledgerDir(config), { recursive: true }); writeFileSync(statePath(config), JSON.stringify(st, null, 2)); }
function selectionsFor(config, codeId) {
  const dir = path.join(ledgerDir(config), 'selections');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))).filter((s) => s.codeId === codeId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function recordShadow({ config, app, runId }) {
  const run = readRuns(config, { app: app.name }).find((r) => r.id === runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.kind !== 'full') throw new Error(`shadow record needs a full run, got ${run.kind}`);
  const st = readState(config);
  const sel = selectionsFor(config, run.fingerprint.codeId).at(-1);
  const rec = { ts: new Date().toISOString(), runId, codeId: run.fingerprint.codeId, selectionId: sel?.id ?? null, hit: null, trivial: false, unpaired: !sel, missed: [], removedMissed: [] };
  if (sel) {
    const a = sel.apps[app.name];
    if (!a || a.mode === 'full') rec.trivial = true;
    else {
      const chosen = new Set(a.specs.map((s) => s.file)); const removed = new Set(a.removed.map((r) => r.spec));
      const failedFiles = [...new Set(run.failures.map((f) => f.file))];
      rec.missed = failedFiles.filter((f) => !chosen.has(f) && !removed.has(f));
      rec.removedMissed = failedFiles.filter((f) => removed.has(f));
      rec.hit = rec.missed.length === 0 && rec.removedMissed.length === 0;
      st.streak = rec.hit ? st.streak + 1 : 0;
    }
  }
  st.window = [...st.window, rec].slice(-20);
  writeState(config, st);
  appendFileSync(path.join(ledgerDir(config), 'shadow.jsonl'), `${JSON.stringify(rec)}\n`);
  return { ...rec, streak: st.streak };
}
export function shadowStatus(config) {
  const st = readState(config);
  return { trust: st.trust, streak: st.streak, promoteAfter: config.shadow.promoteAfter, promotable: st.trust === 'shadow' && st.streak >= config.shadow.promoteAfter, recent: st.window.slice(-5) };
}
export function promote(config) { const st = readState(config); st.trust = 'selected'; writeState(config, st); }
export function demote(config) { const st = readState(config); st.trust = 'shadow'; st.streak = 0; writeState(config, st); }
```

- [ ] **Step 4: 통과 확인** → PASS 2
- [ ] **Step 5: 커밋** → `git commit -am "feat: verify against ledger fingerprints; shadow record/status/promote"`

---

### Task 14: `measure.mjs` 와 `shard.mjs`

**Files:**
- Create: `src/measure.mjs`, `src/shard.mjs`
- Test: `test/measure-shard.test.mjs`

**Interfaces:**
- Produces:
  - `slowest({ config, app, n = 20 }) => [{ file, project, durationMs }]`(최근 `full` 1건) · `retryRates({ config, app, last = 10 }) => [{ file, project, runs, retried, rate }]` · `measureWorkers({ config, app, workersList: number[], testList, mode }) => [{ workers, rc, durationMs, failures, loadAtStart }]`(순차 · 각각 `runTests` · `kind:'selected'` · 원장에 `purpose:'measure'` 를 `command` 뒤에 붙임)
  - `planShards({ config, app, count, fromRun = null }) => { manifest, files: string[] }`: manifest = `{ app, count, fromRun, shards: [{ index, estimatedMs, specs: [{file, projects, estimated}] }] }`, test-list 는 `.e2e-rail/shards/<app>/<i>.txt` · manifest 는 `.e2e-rail/shards/<app>/manifest.json`
  - `mergeReports({ config, app, dir }) => { rc, html: abs|null, complete: boolean }`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/measure-shard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { slowest, retryRates, measureWorkers } from '../src/measure.mjs';
import { planShards, mergeReports } from '../src/shard.mjs';
import { runTests } from '../src/run.mjs';
import { readRuns } from '../src/ledger.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { makeTempRepo } from './helpers.mjs';

test('slowest and retryRates read the ledger', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json'); process.env.STUB_PW_RC = '1';
    await runTests({ config, app, kind: 'full', lock: false });
    delete process.env.STUB_PW_REPORT; delete process.env.STUB_PW_RC;
    await runTests({ config, app, kind: 'full', lock: false });
    const s = slowest({ config, app, n: 2 });
    assert.equal(s[0].file, 'e2e/cart.spec.ts'); assert.equal(s[0].project, 'mobile-chrome');
    const r = retryRates({ config, app });
    const orders = r.find((x) => x.file === 'e2e/orders.spec.ts');
    assert.equal(orders.runs, 2); assert.equal(orders.retried, 1); assert.equal(orders.rate, 0.5);
  } finally { cleanup(); }
});

test('measureWorkers runs each worker count and reports a row per run', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
    const list = path.join(root, '.e2e-rail/list.txt'); readFileSync; require('node:fs').writeFileSync(list, '[chromium] › e2e/orders.spec.ts\n');
    const rows = await measureWorkers({ config, app, workersList: [1, 2], testList: list });
    assert.deepEqual(rows.map((r) => r.workers), [1, 2]);
    assert.equal(readRuns(config).filter((r) => r.command.includes('measure')).length, 2);
  } finally { cleanup(); }
});

test('planShards balances by measured durations, marks unknown specs estimated, merge recognises completeness', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const full = await runTests({ config, app, kind: 'full', lock: false });
    const { manifest } = planShards({ config, app, count: 2 });
    assert.equal(manifest.shards.length, 2);
    const total = manifest.shards.reduce((s, sh) => s + sh.estimatedMs, 0);
    assert.ok(Math.abs(manifest.shards[0].estimatedMs - manifest.shards[1].estimatedMs) <= total / 2);
    assert.ok(existsSync(path.join(root, '.e2e-rail/shards/web/1.txt')));
    assert.ok(manifest.shards.flatMap((s) => s.specs).every((s) => s.estimated === false));
    require('node:fs').writeFileSync(path.join(root, 'e2e/new.spec.ts'), "import { test } from '@playwright/test';\ntest('n', async ({ page }) => { await page.goto('/app/'); });\n");
    const { manifest: m2 } = planShards({ config, app, count: 2, includeSpecs: ['e2e/new.spec.ts'] });
    assert.ok(m2.shards.flatMap((s) => s.specs).find((s) => s.file === 'e2e/new.spec.ts').estimated);
    for (let i = 1; i <= 2; i++) await runTests({ config, app, kind: 'shard', shard: { index: i, count: 2 }, testList: path.join(root, `.e2e-rail/shards/web/${i}.txt`), workers: 1, blob: true, lock: false });
    const blobDir = path.join(root, 'blob-report'); mkdirSync(blobDir, { recursive: true });
    const m = mergeReports({ config, app, dir: blobDir });
    assert.equal(m.rc, 0); assert.ok(existsSync(m.html)); assert.equal(m.complete, true);
    void full;
  } finally { cleanup(); }
});
```

(테스트 안의 `require` 는 `import { writeFileSync } from 'node:fs'` 로 바꿔 써라. 위는 의도를 보이기 위한 축약이다.)

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**

```js
// src/measure.mjs
import { readRuns } from './ledger.mjs';
import { runTests } from './run.mjs';

const lastFull = (config, app) => [...readRuns(config, { app: app.name })].reverse().find((r) => r.kind === 'full');
export function slowest({ config, app, n = 20 }) {
  const run = lastFull(config, app);
  return run ? [...run.specs].sort((a, b) => b.durationMs - a.durationMs).slice(0, n).map(({ file, project, durationMs }) => ({ file, project, durationMs })) : [];
}
export function retryRates({ config, app, last = 10 }) {
  const runs = readRuns(config, { app: app.name }).filter((r) => r.kind === 'full' || r.kind === 'shard').slice(-last);
  const acc = new Map();
  for (const r of runs) for (const s of r.specs) { const k = `${s.file}::${s.project}`; const c = acc.get(k) ?? { file: s.file, project: s.project, runs: 0, retried: 0 }; c.runs++; if (s.retries > 0) c.retried++; acc.set(k, c); }
  return [...acc.values()].map((c) => ({ ...c, rate: c.runs ? c.retried / c.runs : 0 })).sort((a, b) => b.rate - a.rate);
}
export async function measureWorkers({ config, app, workersList, testList, mode = 'dev' }) {
  const rows = [];
  for (const workers of workersList) {
    const { rc, entry } = await runTests({ config, app, kind: 'selected', mode, testList, workers, lock: true, passthrough: ['--', '--e2e-rail-purpose=measure'] });
    rows.push({ workers, rc, durationMs: entry?.durationMs ?? null, failures: entry?.failures.length ?? null, loadAtStart: entry?.lock?.loadAtStart ?? null });
  }
  return rows;
}
```
`passthrough` 의 `--e2e-rail-purpose=measure` 는 Playwright 가 모르는 인자다. `run.mjs` 에서 `passthrough` 중 `--e2e-rail-` 접두는 **spawn 인자에서 제거하고 `command` 문자열에만 남긴다**(Task 12 코드에 `const spawnArgs = args.filter((a) => !a.startsWith('--e2e-rail-'))` 한 줄을 추가하고 `command` 는 원래 `args` 로 기록). 테스트 `measureWorkers … command.includes('measure')` 가 그 보장이다.

```js
// src/shard.mjs
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { readRuns, completeShardSet } from './ledger.mjs';
import { execCapture } from './util/exec.mjs';
import { playwrightCli } from './util/playwright.mjs';
import { computeFingerprint } from './fingerprint.mjs';

export function planShards({ config, app, count, fromRun = null, includeSpecs = [] }) {
  const runs = readRuns(config, { app: app.name });
  const src = fromRun ? runs.find((r) => r.id === fromRun) : [...runs].reverse().find((r) => r.kind === 'full');
  if (!src) throw new Error('no full run in ledger to plan from; run `e2e-rail run --full` once');
  const byFile = new Map();
  for (const s of src.specs) { const c = byFile.get(s.file) ?? { file: s.file, projects: [], ms: 0, estimated: false }; c.projects.push(s.project); c.ms += s.durationMs; byFile.set(s.file, c); }
  const known = [...byFile.values()].map((c) => c.ms).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1000;
  for (const f of includeSpecs) if (!byFile.has(f)) byFile.set(f, { file: f, projects: ['chromium'], ms: median, estimated: true });
  const items = [...byFile.values()].sort((a, b) => b.ms - a.ms);
  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, estimatedMs: 0, specs: [] }));
  for (const it of items) { const target = shards.reduce((m, s) => (s.estimatedMs < m.estimatedMs ? s : m)); target.specs.push({ file: it.file, projects: [...new Set(it.projects)].sort(), estimated: it.estimated }); target.estimatedMs += it.ms; }
  const dir = path.join(ledgerDir(config), 'shards', app.name); mkdirSync(dir, { recursive: true });
  const files = [];
  for (const s of shards) { const abs = path.join(dir, `${s.index}.txt`); writeFileSync(abs, `${s.specs.flatMap((x) => x.projects.map((p) => `[${p}] › ${x.file}`)).join('\n')}\n`); files.push(abs); }
  const manifest = { app: app.name, count, fromRun: src.id, generatedAt: new Date().toISOString(), shards };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, files };
}
export function mergeReports({ config, app, dir, mode = 'dev' }) {
  const dirAbs = appDir(config, app);
  const r = execCapture('node', [playwrightCli(dirAbs), 'merge-reports', '--reporter', 'html', dir], { cwd: dirAbs });
  const html = existsSync(path.join(dir, 'index.html')) ? path.join(dir, 'index.html') : (existsSync(path.join(dirAbs, 'playwright-report/index.html')) ? path.join(dirAbs, 'playwright-report/index.html') : null);
  const fp = computeFingerprint({ config, app, mode });
  const complete = completeShardSet(readRuns(config, { app: app.name }), app.name, fp.id) !== null;
  return { rc: r.status, html, complete };
}
```

- [ ] **Step 4: 통과 확인** → PASS 3
- [ ] **Step 5: 커밋** → `git commit -am "feat: measure slowest/retry/workers; shard plan by measured durations and merge-reports wrapper"`

---

### Task 15: CLI 배선 — `init` · `map` · 전 서브커맨드

**Files:**
- Modify: `src/cli.mjs`(Task 1 골격의 `COMMANDS` 채우기)
- Create: `src/commands/{init,map,select,run,verify,shadow,measure,shard,lock}.mjs`
- Test: `test/cli-commands.test.mjs`

**Interfaces:**
- Produces: 각 `src/commands/<name>.mjs` 가 `export default async function (argv) => exitCode`. 공통 파서 `parse(argv, optionsSpec)` 는 `node:util` 의 `parseArgs`(`allowPositionals: true`, `strict: false`)를 감싼다(`src/commands/_args.mjs`).
- 명령·옵션 표(README 와 스킬이 이 표를 인용한다):

| 명령 | 옵션 | 출력 · 종료 코드 |
| --- | --- | --- |
| `init` | `--force` | 설정 생성(앱 자동 탐지: `**/playwright.config.{ts,js,mjs}` · node_modules 제외) · `.gitignore` 에 `.e2e-rail/` · `package.json` 스크립트 제안 출력(`e2e:select`·`e2e:run`·`e2e:verify`) · 0 |
| `map` | `--app` · `--check` · `--explain <spec>` | 인덱스 (재)생성 · `--check`: unmapped 목록과 비율 · `--explain`: 그 spec 의 routes/apis/imports/supports · 0 |
| `select` | `--app` · `--base` · `--head` · `--no-uncommitted` · `--add <spec> --reason <text>` · `--remove <spec> --reason <text>` · `--json` | `selection.json` + test-list 경로 · 요약 표(앱 · mode · spec 수 · 이유 상위 3) · 0 partial / 10 full |
| `run` | `--app` · `--full` · `--selection [id]` · `--test-list <file>` · `--last-failed` · `--mode dev\|preview` · `--workers N` · `--project` · `--shard i/n` · `--blob` · `--no-lock` · `--no-build` · `-- <playwright args>` | 원장 1줄 · `run-id` 출력 · Playwright rc 그대로. `--selection` 인데 `trust=shadow` 면 «shadowed» 경고 1줄 |
| `verify` | `--app` · `--mode` · `--require full\|selected` · `--max-age <min>` · `--json` | 0 / 20 stale(+ differing · lastVerifiedHead) / 21 insufficient |
| `shadow` | `record --run <id>` · `status` · `promote` · `demote` | 0 · `status` 에 promotable 표시 |
| `measure` | `slowest [-n]` · `retries [--last]` · `workers <1,2,4> --test-list <file>` | 표 출력 · 0 |
| `shard` | `plan --count N [--from-run] [--include <spec>…]` · `merge --dir <blob>` | manifest 경로 · merge 는 `complete` 여부 |
| `lock` | `status` · `reap` · `run <heavy\|light> -- <cmd…>` | 0 · `run` 은 명령 rc |

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/cli-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRepo } from './helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'e2e-rail.mjs');
const cli = (root, args, env = {}) => { try { return { code: 0, out: execFileSync('node', [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };

test('init detects playwright config, writes config and gitignore; map --check reports unmapped', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    rmSync(path.join(root, 'e2e-rail.config.mjs'));
    const r = cli(root, ['init']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(path.join(root, 'e2e-rail.config.mjs')));
    assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.e2e-rail\//);
    assert.match(r.out, /e2e:select/);
    const m = cli(root, ['map', '--check']);
    assert.equal(m.code, 0, m.out); assert.match(m.out, /unmapped/); assert.match(m.out, /smoke\.spec\.ts/);
    const e = cli(root, ['map', '--explain', 'e2e/cart.spec.ts']);
    assert.match(e.out, /routes.*cart/s);
  } finally { cleanup(); }
});

test('select → run --selection → verify round trip with exit codes', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    writeFileSync(path.join(root, 'src/components/Table.ts'), 'export const Table = (rows: unknown[]) => rows.length + 1;\n');
    const s = cli(root, ['select', '--base', 'HEAD']);
    assert.equal(s.code, 0, s.out); assert.match(s.out, /partial/);
    assert.ok(existsSync(path.join(root, '.e2e-rail/test-list.web.txt')));
    const full = cli(root, ['select', '--base', 'nope']);
    assert.equal(full.code, 10);
    const v0 = cli(root, ['verify']); assert.equal(v0.code, 20);
    const r = cli(root, ['run', '--selection', '--workers', '1', '--no-lock']);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /shadow/i);
    assert.equal(cli(root, ['verify']).code, 21);
    assert.equal(cli(root, ['verify', '--require', 'selected']).code, 0);
    const f = cli(root, ['run', '--full', '--no-lock']); assert.equal(f.code, 0, f.out);
    assert.equal(cli(root, ['verify']).code, 0);
    const runId = f.out.match(/run-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}/)[0];
    const sh = cli(root, ['shadow', 'record', '--run', runId]); assert.equal(sh.code, 0, sh.out);
    assert.match(cli(root, ['shadow', 'status']).out, /streak/);
  } finally { cleanup(); }
});

test('lock run executes a command under the lock and passes rc through', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    assert.equal(cli(root, ['lock', 'run', 'light', '--', 'node', '-e', 'process.exit(3)']).code, 3);
    assert.match(cli(root, ['lock', 'status']).out, /heavy/);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**

```js
// src/commands/_args.mjs
import { parseArgs } from 'node:util';
export function parse(argv, options) {
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv; const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  const { values, positionals } = parseArgs({ args: own, options, allowPositionals: true, strict: false });
  return { values, positionals, passthrough };
}
export const table = (rows) => { if (!rows.length) return '(none)'; const keys = Object.keys(rows[0]); const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length))); const line = (r) => keys.map((k, i) => String(r[k] ?? '').padEnd(w[i])).join('  '); return [line(Object.fromEntries(keys.map((k) => [k, k]))), ...rows.map(line)].join('\n'); };
```

```js
// src/commands/init.mjs
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../config.mjs';
import { walk } from '../util/glob.mjs';
import { parse } from './_args.mjs';

export default async function init(argv) {
  const { values } = parse(argv, { force: { type: 'boolean' } });
  const root = process.cwd();
  const cfgAbs = path.join(root, CONFIG_FILE);
  if (existsSync(cfgAbs) && !values.force) { console.log(`${CONFIG_FILE} exists (use --force to overwrite)`); }
  else {
    const configs = walk(root).filter((r) => /(^|\/)playwright\.config\.(ts|js|mjs|cjs)$/.test(r));
    if (!configs.length) { console.error('no playwright.config.* found'); return 1; }
    const apps = configs.map((rel) => { const dir = path.posix.dirname(rel); const pkg = path.join(root, dir, 'package.json'); const name = existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).name?.replace(/^@.*\//, '') ?? path.posix.basename(dir) : path.posix.basename(dir) || 'app'; return { name: name === '.' ? 'app' : name, root: dir, playwrightConfig: path.posix.basename(rel) }; });
    let tpl = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../templates/e2e-rail.config.mjs'), 'utf8');
    tpl = tpl.replace('__APP_NAME__', apps[0].name).replace('__APP_ROOT__', apps[0].root).replace('__PW_CONFIG__', apps[0].playwrightConfig);
    if (apps.length > 1) tpl += `\n// detected more apps — add them to apps[]: ${JSON.stringify(apps.slice(1))}\n`;
    writeFileSync(cfgAbs, tpl);
    console.log(`wrote ${CONFIG_FILE} (apps detected: ${apps.map((a) => `${a.name}@${a.root}`).join(', ')})`);
  }
  const gi = path.join(root, '.gitignore');
  if (!existsSync(gi) || !readFileSync(gi, 'utf8').includes('.e2e-rail/')) { appendFileSync(gi, '\n# e2e-rail ledger, caches and selections\n.e2e-rail/\n'); console.log('added .e2e-rail/ to .gitignore'); }
  console.log(['', 'suggested package.json scripts:', '  "e2e:select": "e2e-rail select --base $(cat .e2e-rail/last-green.<app> 2>/dev/null)"', '  "e2e:run":    "e2e-rail run --selection"', '  "e2e:verify": "e2e-rail verify --require full"', '', 'next: e2e-rail map --check'].join('\n'));
  return 0;
}
```

```js
// src/commands/map.mjs
import { loadConfig, findApp, appDir } from '../config.mjs';
import { loadTypeScript } from '../util/ts.mjs';
import { loadOrBuildSpecIndex } from '../spec-index.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { parse } from './_args.mjs';

export default async function map(argv) {
  const { values } = parse(argv, { app: { type: 'string' }, check: { type: 'boolean' }, explain: { type: 'string' } });
  const config = await loadConfig(process.cwd()); const app = findApp(config, values.app); const ts = await loadTypeScript(appDir(config, app));
  const index = await loadOrBuildSpecIndex({ config, app, ts });
  const specs = Object.entries(index.specs);
  if (values.explain) { const s = index.specs[values.explain]; if (!s) { console.error(`unknown spec ${values.explain}`); return 1; } console.log(JSON.stringify({ spec: values.explain, ...s }, null, 2)); return 0; }
  const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts });
  console.log(`app ${app.name}: ${specs.length} specs indexed · ${entries.length} route entries · adapter unresolved ${unresolved.length}`);
  for (const u of unresolved) console.log(`  ! ${u}`);
  if (values.check) {
    const un = specs.filter(([, s]) => s.unmapped).map(([f]) => f);
    console.log(`unmapped: ${un.length}/${specs.length} (${specs.length ? Math.round((un.length / specs.length) * 100) : 0}%) — these run on every src change`);
    for (const f of un) console.log(`  - ${f}`);
  }
  return 0;
}
```

나머지 명령은 같은 꼴이다. 핵심만 적는다(각 파일은 `parse` → `loadConfig` → 해당 모듈 호출 → 출력 → 종료 코드).

```js
// src/commands/select.mjs  (요지)
const { values } = parse(argv, { app: { type: 'string' }, base: { type: 'string' }, head: { type: 'string', default: 'HEAD' }, uncommitted: { type: 'boolean', default: !process.env.CI }, add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true }, reason: { type: 'string' }, json: { type: 'boolean' } });
if (values.add?.length || values.remove?.length) { const st = readState(config); const sel = amendSelection(config, { app: values.app, add: (values.add ?? []).map((spec) => ({ spec, reason: values.reason ?? '' })), remove: (values.remove ?? []).map((spec) => ({ spec, reason: values.reason ?? '' })), allowRemove: st.trust === 'selected' }); print(sel); return selectionExitCode(sel); }
const sel = await select({ config, ts, base: values.base, head: values.head, includeUncommitted: values.uncommitted });
const { testLists } = writeSelection(config, sel);
if (values.json) console.log(JSON.stringify(sel, null, 2)); else for (const [name, a] of Object.entries(sel.apps)) console.log(`${name}: ${a.mode}${a.mode === 'partial' ? ` · ${a.specs.length} specs · unmapped ${a.unmappedIncluded} · list ${testLists[name]}` : ` · ${a.reasons.slice(0, 3).join(' | ')}`}`);
return selectionExitCode(sel);
```
`ts` 는 모든 앱이 같은 `typescript` 를 쓰지 않을 수 있으므로 `select` 안에서 앱별로 `loadTypeScript(appDir(config, app))` 를 호출하도록 Task 9 의 `select()` 시그니처에서 `ts` 를 선택 인자로 바꾸고, 없으면 앱별로 로드한다.

```js
// src/commands/run.mjs  (요지)
const { values, passthrough } = parse(argv, { app:{type:'string'}, full:{type:'boolean'}, selection:{type:'string'}, 'test-list':{type:'string'}, 'last-failed':{type:'boolean'}, mode:{type:'string', default:'dev'}, workers:{type:'string'}, project:{type:'string'}, shard:{type:'string'}, blob:{type:'boolean'}, lock:{type:'boolean', default:true}, build:{type:'boolean', default:true} });
// --selection: 값이 없으면 selection.json, 있으면 selections/<id>.json. 해당 앱 mode=full 이면 전수로 승격해 돌리고 그 사실을 출력
// trust=shadow 이고 kind=selected 면 console.warn('shadowed: selected run does not replace a full run while trust=shadow')
// shard: 'i/n' → { index, count }
// 끝: console.log(`run-id ${entry.id} · kind ${entry.kind} · rc ${rc} · ${entry.durationMs}ms · failures ${entry.failures.length}`); return rc
```
```js
// src/commands/verify.mjs — verify() 결과를 한 줄 + (stale 이면) `differing: diff,untracked` · `select --base <lastVerifiedHead>` 힌트. --json 지원. return exitCode
// src/commands/shadow.mjs — positionals[0] ∈ record|status|promote|demote. status 는 `trust · streak/promoteAfter · promotable` + recent 5 줄
// src/commands/measure.mjs — positionals[0] ∈ slowest|retries|workers. workers 는 `1,2,4` 파싱 → measureWorkers → table()
// src/commands/shard.mjs — positionals[0] ∈ plan|merge
// src/commands/lock.mjs — status|reap|run <cls> -- cmd…  (run: acquire → execInherit → release → return status)
```

`src/cli.mjs` 의 `COMMANDS` 는 동적 import 로 채운다:
```js
export const COMMANDS = Object.fromEntries(['init', 'map', 'select', 'run', 'verify', 'shadow', 'measure', 'shard', 'lock'].map((n) => [n, async (argv) => (await import(`./commands/${n}.mjs`)).default(argv)]));
```

- [ ] **Step 4: 통과 확인** → `node --test` 전체 PASS
- [ ] **Step 5: 커밋** → `git commit -am "feat(cli): init, map, select, run, verify, shadow, measure, shard, lock commands"`

---

### Task 16: 플러그인 층 — 스킬 · 에이전트 · 훅 · Codex 패키지 · 템플릿 · README

**Files:**
- Create: `skills/{init,select,gate,measure,shadow}/SKILL.md`, `agents/e2e-impact-analyst.md`, `references/impact-analyst.md`, `hooks/hooks.json`, `hooks/doctrine.md`, `.agents/plugins/marketplace.json`, `plugins/e2e-rail/.codex-plugin/plugin.json`, `plugins/e2e-rail/hooks/hooks.json`, `scripts/sync-codex.mjs`, `templates/ci/{github-actions-shard.yml,codebuild-batch.yml,buildspec-snippet.yml}`, `README.md`, `README.ko.md`, `CHANGELOG.md`
- Test: `test/plugin-layer.test.mjs`

**Interfaces:**
- Produces: 스킬 frontmatter `name` · `description`(영어 · «Use when…» · «Do NOT load for…» 포함) · 본문은 CLI 호출과 보고 형식만. `scripts/sync-codex.mjs`: 루트 `skills/`·`hooks/doctrine.md`·`references/` 를 `plugins/e2e-rail/` 아래로 복사(멱등 · 삭제도 반영).

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/plugin-layer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = ['init', 'select', 'gate', 'measure', 'shadow'];

test('every skill has frontmatter with name/description and calls the CLI via pnpm exec', () => {
  for (const s of SKILLS) {
    const md = readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: `), s);
    assert.match(md, /pnpm exec e2e-rail|npx e2e-rail/, s);
  }
  assert.match(readFileSync(path.join(root, 'skills/gate/SKILL.md'), 'utf8'), /--last-failed[\s\S]*never/i);
});

test('codex package mirrors root skills, doctrine and references exactly', () => {
  execFileSync('node', [path.join(root, 'scripts/sync-codex.mjs')]);
  for (const s of SKILLS) assert.equal(readFileSync(path.join(root, 'plugins/e2e-rail/skills', s, 'SKILL.md'), 'utf8'), readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8'));
  assert.equal(readFileSync(path.join(root, 'plugins/e2e-rail/hooks/doctrine.md'), 'utf8'), readFileSync(path.join(root, 'hooks/doctrine.md'), 'utf8'));
  assert.equal(readFileSync(path.join(root, 'plugins/e2e-rail/references/impact-analyst.md'), 'utf8'), readFileSync(path.join(root, 'references/impact-analyst.md'), 'utf8'));
  const codex = JSON.parse(readFileSync(path.join(root, 'plugins/e2e-rail/.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(codex.name, 'e2e-rail'); assert.equal(codex.skills, './skills/');
  const mk = JSON.parse(readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(mk.plugins[0].source.path, './plugins/e2e-rail');
});

test('hooks.json runs doctrine on SessionStart; doctrine is short', () => {
  const h = JSON.parse(readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
  assert.match(h.hooks.SessionStart[0].hooks[0].command, /doctrine\.md/);
  assert.ok(readFileSync(path.join(root, 'hooks/doctrine.md'), 'utf8').split('\n').filter(Boolean).length <= 12);
  for (const f of ['templates/ci/github-actions-shard.yml', 'templates/ci/codebuild-batch.yml', 'templates/ci/buildspec-snippet.yml', 'README.md', 'README.ko.md', 'CHANGELOG.md']) assert.ok(existsSync(path.join(root, f)), f);
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 파일 작성**

`hooks/doctrine.md`:
```
# e2e-rail doctrine (applies to every E2E claim in this session)

1. Before reporting any E2E result, run `pnpm exec e2e-rail verify` and quote its line. A green you did not verify against the current fingerprint is not a green.
2. `--last-failed` reruns are diagnostics. Never report a rerun as a full pass.
3. A selected run is reported with its selection block (change · selected · reasons · mobile · unmapped · final full). No block, no selected run.
4. While `shadow status` says trust=shadow, a selected run never replaces a full run; say "shadowed".
5. Widening is never wrong; narrowing without a recorded reason is. Add specs with `select --add --reason`; removal only after promotion.
6. Heavy runs (full, shard) take the exclusive lock. Do not run `playwright test` directly for anything you intend to report.
```

`hooks/hooks.json`(self-improvement 와 동일 형식):
```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "cat \"${CLAUDE_PLUGIN_ROOT}/hooks/doctrine.md\"", "timeout": 5 } ] } ] } }
```

`skills/select/SKILL.md` (가장 중요한 스킬 · 다른 넷은 같은 꼴):
```markdown
---
name: select
description: Use when a code change needs its E2E scope decided — before running Playwright on a branch, worktree or PR. Produces the selection block (change · selected specs · reasons · mobile · unmapped · final full) that every E2E report must carry. Do NOT load for: running the suite (gate), tuning speed (measure), promotion decisions (shadow).
---

# e2e-rail:select — decide the E2E scope and record why

## 1. Compute
```sh
pnpm exec e2e-rail select --base <last verified SHA or merge-base> [--app <name>]
```
Exit 0 = partial, 10 = full. Read `.e2e-rail/selection.json`.
No base? Use `cat .e2e-rail/last-green.<app>` or the branch merge-base. Unsure → omit `--base` and accept full.

## 2. Check what the script cannot see
Claude Code: delegate to the `e2e-impact-analyst` agent with the diff and `selection.json`.
Codex: read `references/impact-analyst.md` and run its checklist yourself.
It returns `--add` candidates only. Apply each:
```sh
pnpm exec e2e-rail select --add e2e/<spec>.spec.ts --reason "<one sentence>"
```
Never `--remove` while `shadow status` shows trust=shadow.

## 3. Write the selection block (paste into your report verbatim)
```
change:   <what changed, 1 line + top files>
selected: <spec slugs> (reasons: route:… · api:… · import:…)
added:    <slug — reason> | none      removed: none
mobile:   <slugs that run on the mobile project, from the test-list>
unmapped: <N> (from `map --check`)
final:    full run in the integration step · trust=<shadow|selected>
```
## 4. Hand off
`e2e-rail:gate` runs it. Do not run `playwright test` yourself.
```

`skills/gate/SKILL.md` 핵심 문장: `pnpm exec e2e-rail run --selection|--full --mode preview` → `pnpm exec e2e-rail verify --require full` → 보고 형식 `verify: <line> · run-id · kind · rc · failures(with file:title)` · «`--last-failed` is **never** reported as a full pass» · `trust=shadow` 면 «shadowed» 표기 · 실패 시 `run --last-failed` 는 진단 후 원인 1줄과 함께, 그리고 다시 `run --full`.

`skills/init/SKILL.md`: 설치 확인(`pnpm exec e2e-rail --version` 실패 시 `pnpm add -D github:sh5623/e2e-rail#v0.1.0`) → `init` → `map --check` → unmapped 비율과 상위 5개 spec 을 보고하고 리터럴 상수 제안 → `package.json` 스크립트 제안 적용 여부를 사람에게.

`skills/measure/SKILL.md`: 4단계 ① `measure slowest -n 20` ② 느린 spec 의 trace 로 «페이지 진입 · 응답 대기 · 반복 준비» 중 어디가 느린지 분리(`run --test-list <one> -- --trace on`) ③ `measure workers 1,2,4 --test-list <list>` 표 → `run.workers` 에 사람이 기록 ④ 여전히 길면 `shard plan --count N` + CI 템플릿.

`skills/shadow/SKILL.md`: 라운드 마감에 `shadow record --run <full run-id>` → `shadow status` → promotable 이면 사람에게 «promote?» 제안(자동 금지) → miss 가 있으면 missed spec 과 그 spec 의 `map --explain` 을 보고서에.

`agents/e2e-impact-analyst.md`:
```markdown
---
name: e2e-impact-analyst
description: READ-ONLY. Given a diff and .e2e-rail/selection.json, finds couplings the static graph cannot see (modal openers, deep links, string-literal navigation, runtime-registered routes, import.meta.glob, shared fixtures) and returns `--add` candidates with one-sentence reasons. Never proposes removals. Use from e2e-rail:select step 2 in Claude Code.
tools: Read, Grep, Glob, Bash
---
# e2e-impact-analyst
Checklist (run every item, report only hits):
1. `navigate('/…')` / `<Link to>` / `window.location` string routes in changed files → specs whose routes match (`map --explain`).
2. Changed component used by a modal/popup opened from another route → that route's specs.
3. Changed `services/*` without `/api/` literals → consumers via `grep -rl "<export name>" src`.
4. Changed shared fixture or support helper outside `supportDirs` → specs importing it.
5. Mobile: if a changed file branches on viewport/touch, make sure the spec's mobile project is in the test-list.
Output: `- add e2e/<spec>.spec.ts — <reason>` lines, or `no additions`.
```
`references/impact-analyst.md` 는 위 Checklist 와 Output 을 frontmatter 없이 그대로 담는다.

`.agents/plugins/marketplace.json`:
```json
{ "name": "e2e-rail-codex", "interface": { "displayName": "e2e-rail (Codex)" }, "plugins": [ { "name": "e2e-rail", "source": { "source": "local", "path": "./plugins/e2e-rail" }, "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }, "category": "Engineering" } ] }
```
`plugins/e2e-rail/.codex-plugin/plugin.json`:
```json
{ "name": "e2e-rail", "version": "0.1.0", "description": "Change-aware Playwright E2E selection, verification ledger and sharding — Codex skills over the e2e-rail CLI.", "author": { "name": "Seungho" }, "skills": "./skills/", "interface": { "displayName": "e2e-rail (Codex)", "shortDescription": "Select, verify and shard Playwright E2E by change.", "longDescription": "Codex-native skills and SessionStart doctrine over the runtime-agnostic e2e-rail CLI installed in the repo.", "developerName": "Seungho", "category": "Engineering", "capabilities": ["Read", "Write"], "defaultPrompt": [ "Use $e2e-rail:init to set this repo up.", "Use $e2e-rail:select to decide the E2E scope for this change.", "Use $e2e-rail:gate to run and report it." ] }, "homepage": "https://github.com/sh5623/e2e-rail", "repository": "https://github.com/sh5623/e2e-rail.git", "license": "MIT" }
```
`plugins/e2e-rail/hooks/hooks.json` 은 루트와 같되 경로가 `${CODEX_PLUGIN_ROOT}` 가 아니라 self-improvement Codex 패키지의 `hooks/hooks.json` 을 열어 **그 변수명을 그대로** 쓴다(구현 시 확인 · 다르면 그쪽이 정본).

`scripts/sync-codex.mjs`:
```js
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dst = path.join(root, 'plugins/e2e-rail');
for (const [from, to] of [['skills', 'skills'], ['references', 'references'], ['hooks/doctrine.md', 'hooks/doctrine.md']]) {
  const t = path.join(dst, to); rmSync(t, { recursive: true, force: true }); mkdirSync(path.dirname(t), { recursive: true }); cpSync(path.join(root, from), t, { recursive: true });
}
console.log('synced skills, references, doctrine → plugins/e2e-rail');
```

`templates/ci/github-actions-shard.yml`(요지): `strategy.matrix.shard: [1,2,3,4]` · 각 잡 `pnpm exec e2e-rail run --app <app> --full --shard ${{ matrix.shard }}/4 --blob --mode preview` · `actions/upload-artifact` 로 `blob-report` · 마지막 잡이 `download-artifact` 후 `pnpm exec e2e-rail shard merge --dir blob-report` · `.e2e-rail/` 를 `actions/cache` 로 보존(`last-green` 용). `codebuild-batch.yml`: `batch.build-graph` 로 같은 모양. `buildspec-snippet.yml`: 섀도 기간용 한 줄 `pnpm exec e2e-rail run --app <app> --full --mode preview` + `shadow record`.

`README.md`: 목적 3줄 · Install(npm · Claude · Codex) · Setup 5단계(스펙 §1) · 명령 표(Task 15 표) · Shadow mode · Sharding · Config reference(스펙 §3) · Limits(스펙 §13). `README.ko.md` 는 같은 구조의 한국어. `CHANGELOG.md` 에 `## 0.1.0 — 2026-10-xx` 초기 항목.

- [ ] **Step 4: 통과 확인** → `node --test` 전체 PASS
- [ ] **Step 5: 커밋** → `git commit -am "feat(plugin): skills, impact analyst, doctrine hook, Codex package, CI templates and docs"`

---

### Task 17: 계약 테스트(실 Playwright) · 릴리스 · guardrail 등재

**Files:**
- Create: `test/contract/real-playwright.test.mjs`, `test/fixtures/contract-app/`(실 Playwright 가 도는 최소 앱: `playwright.config.ts` + `e2e/a.spec.ts` + `e2e/b.spec.ts` · `webServer` 없이 `page.setContent` 만 쓴다)
- Modify: `CHANGELOG.md`, guardrail 레포 `.claude-plugin/marketplace.json`(별도 PR)

**Interfaces:**
- Consumes: Task 12 `runTests` · Task 4 `listTests`.
- 검증 항목: ① `listTests` 가 실 JSON 의 `rootDir` 기준 경로를 앱 루트 기준으로 되돌린다(`e2e/a.spec.ts`) ② `--test-list` 한 줄 `[chromium] › e2e/a.spec.ts` 로 돌리면 JSON 리포트에 `a` 만 있고 `b` 는 없다 ③ 원장 1줄 · `verify --require selected` 0.

- [ ] **Step 1: 테스트 작성**

```js
// test/contract/real-playwright.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from '../helpers.mjs';
import { loadConfig, findApp } from '../../src/config.mjs';
import { listTests } from '../../src/util/playwright.mjs';
import { runTests } from '../../src/run.mjs';
import { verify } from '../../src/verify.mjs';

const skip = !process.env.E2E_RAIL_CONTRACT;
test('real playwright: --list paths, --test-list line format, ledger + verify', { skip }, async () => {
  const { root, cleanup } = makeTempRepo('contract-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const tests = listTests(root, app.playwrightConfig);
    assert.deepEqual(Object.keys(tests).sort(), ['e2e/a.spec.ts', 'e2e/b.spec.ts']);
    mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
    const list = path.join(root, '.e2e-rail/list.txt'); writeFileSync(list, '[chromium] › e2e/a.spec.ts\n');
    const { rc, entry } = await runTests({ config, app, kind: 'selected', testList: list, workers: 1, lock: false });
    assert.equal(rc, 0);
    assert.deepEqual(entry.specs.map((s) => s.file), ['e2e/a.spec.ts']);
    assert.equal(verify({ config, app, require: 'selected' }).status, 'verified');
  } finally { cleanup(); }
});
```

`contract-app` 의 `package.json` 은 `devDependencies` 없이 두고, `createRequire(appDir)` 가 e2e-rail 레포 루트의 `node_modules/@playwright/test`(devDependency) 를 찾도록 `test/fixtures/contract-app` 에 `node_modules` 를 두지 않는다. `e2e-rail.config.mjs` 는 `adapter: { name: 'manual', map: {} }`.

- [ ] **Step 2: 실행** → `npx playwright install chromium && npm run test:contract` PASS. 실패하면 메시지가 «`--test-list` 경로 기준» 또는 «JSON `rootDir`» 중 어느 것인지 가리킨다. `--test-list` 가 config 디렉터리가 아니라 `rootDir` 기준이면 `writeSelection`·`planShards` 의 줄 생성을 `path.relative(rootDir, …)` 로 바꾸고 `listTests` 에서 `rootDir` 를 함께 돌려준다.
- [ ] **Step 3: 커밋** → `git commit -am "test: real-playwright contract test for list paths, test-list format and ledger"`
- [ ] **Step 4: 릴리스** → `CHANGELOG.md` 0.1.0 항목 확정 · `npm run sync:codex` · `git tag v0.1.0 && git push origin main --tags`.
- [ ] **Step 5: guardrail 등재** → `sh5623/guardrail` 의 `.claude-plugin/marketplace.json` `plugins[]` 에 추가하고 README 표에 한 줄:
```json
{ "name": "e2e-rail", "description": "Change-aware Playwright E2E — select only the specs a change can reach, verify runs against a code fingerprint, shard by measured durations. Runtime-agnostic CLI with Claude Code and Codex skill layers.", "category": "engineering", "tags": ["e2e", "playwright", "testing", "ci", "harness"], "source": { "source": "github", "repo": "sh5623/e2e-rail" } }
```
- [ ] **Step 6: 첫 도입** → bfm-fo-front 에서 스펙 §12 의 1~2 단계(`pnpm add -D github:sh5623/e2e-rail#v0.1.0` · `init` · `map --check` · final-gate 의 `07-e2e` 교체). 이 단계는 그 레포의 git 규칙을 따른다(커밋은 사용자 지시 후).

---

## 자가 검토 결과

- **스펙 커버리지**: §1 배포(Task 1·16·17) · §2 구조(1·15·16) · §3 설정(3) · §4 인덱스(4·6) · §5 그래프·어댑터(7·8) · §6 선택(9) · §7 지문·원장(10·11) · §8 verify·섀도(13) · §9 run·락·워커·샤드·last-green(11·12·14·16 템플릿) · §10 스킬·에이전트·훅·Codex(16) · §11 테스트(각 태스크 + 17) · §12 도입(17 Step 6) · §13 한계(README). 빠진 항목 없음.
- **타입 일관성**: `Selection.apps[name].specs[].projects` · `testListLines` · `planShards` 의 줄 형식 `[<project>] › <file>` 이 동일. `fingerprint.codeId` 는 Task 10 에서 정의하고 Task 13 섀도가 사용. `newId` 는 `select.mjs` 에서 정의하고 `ledger`·`run` 이 import.
- **Review Focus** 5건 모두 소유 태스크에 테스트가 있다(12 preview 거부 · 11 손상 줄 · 13 unpaired · 12 고아 락 · 14 estimated).
- **의존 순서**: 1 → 2 → (3, 4) → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17. 3 과 4 는 병렬 가능. 16 은 15 와 병렬 가능(문서만).
