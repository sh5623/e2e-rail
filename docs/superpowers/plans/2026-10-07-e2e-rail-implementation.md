# e2e-rail 구현 계획 (1부: 기반 · 인덱스 · 그래프 · 선택)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Playwright E2E 를 변경 기반으로 선택·실행·기록·분산하는 런타임 비종속 CLI(`e2e-rail`)와 그 위의 Claude/Codex 플러그인 층을 만든다.

**Architecture:** 코어는 의존성 0 의 ESM node 스크립트(`src/*.mjs`)이고 호스트 레포의 `typescript` 와 `@playwright/test` 를 `createRequire(appDir)` 로 빌린다. spec 인덱스(TS AST) + 역방향 import 그래프 + 어댑터(라우트→진입 파일)로 변경 파일을 spec 목록으로 바꾸고, 모든 실행은 지문과 함께 `.e2e-rail/ledger.jsonl` 에 남는다. Claude/Codex 층은 그 CLI 를 호출하는 스킬 문서뿐이다.

**Tech Stack:** Node ≥ 20 (ESM · `node:test` · `util.parseArgs`) · TypeScript compiler API(peer) · Playwright CLI(peer) · git.

**Spec:** `docs/superpowers/specs/2026-10-07-e2e-rail-design.md` — 이 계획은 그 스펙을 근거로 쓴다. 두 문서를 함께 읽어라.

**2부:** `docs/superpowers/plans/2026-10-07-e2e-rail-implementation-part2.md` (태스크 10~17: 지문·원장·run·lock·verify·shadow·measure·shard·CLI·플러그인 층·릴리스).

## Global Constraints

- 런타임 의존성 0. `package.json` `dependencies` 는 비어 있어야 한다. `typescript` · `@playwright/test` 는 `peerDependencies`(`peerDependenciesMeta` optional) + `devDependencies`(테스트용).
- `engines.node >= 20`. ESM 전용(`"type": "module"`, 확장자 `.mjs`).
- 좁혀서 틀리지 않는다: 판정 불가 → 전수. 선택기 코드에서 «모르면 비운다» 는 분기는 버그다.
- 모든 경로는 내부에서 **앱 루트 기준 상대 경로(POSIX 구분자)** 로 다룬다. 절대 경로는 파일 I/O 직전에만 만든다. Windows 를 1급으로 지원하지는 않지만 `path.posix` 변환은 지킨다.
- 원장은 append-only. 기존 줄을 수정·삭제하는 코드는 쓰지 않는다.
- 🔴 전체 스테이징 플래그(`-A`·`.`)는 사용자 환경의 fe-rail 가드가 차단한다. 커밋 전엔 Files 블록의 경로를 명시해 `git add -- a b c` 로 올린다.
- 커밋 메시지는 Conventional Commits(`feat:` · `test:` · `docs:` · `chore:`). 각 태스크 끝에 커밋.
- 테스트 러너는 `node --test`. 픽스처는 `test/fixtures/` 아래, 임시 레포는 `os.tmpdir()` 에 만들고 끝에 지운다.
- 스킬·에이전트·README 본문은 영어, `README.ko.md` 는 한국어(self-improvement v0.5.0 이후 관례).

## Review Focus

스펙이 암시하지만 아래 태스크의 테스트가 직접 치지 않는 입력 5가지. 각 줄의 테스트는 해당 태스크에 추가해 두었다.

1. **`goto` 인자가 함수 호출이나 매개변수**(`goto(buildUrl())` · `goto(page, path)`)인 spec → `unmapped` 로 떨어져야 하고 예외로 죽으면 안 된다. (Task 6 `unmapped` 테스트)
2. **spec 이 `@/` 로 src 를 import 하는데 그 파일이 삭제된 경우** → 그래프에 없는 파일은 `unresolved` 로 전수가 돼야 한다. (Task 8 `unresolved` 테스트는 «삭제된 파일 경로» 를 변경 목록에 넣는다)
3. **`--base` 가 shallow clone 에 없는 SHA** → `gitChangedFiles` 가 `null` 을 돌려주고 select 는 전수여야 한다. (Task 2 git 테스트)
4. **라우트 파일의 `path` 가 변수나 템플릿**(`path: \`${BASE}/x\``) → 어댑터 `unresolved` 에 들어가고 select 가 전수여야 한다. (Task 7 테스트)
5. **tiers.full 과 srcDir 이 겹칠 때**(`src/routes/**` 는 둘 다) → 표의 «위에서부터 첫 행» 규칙대로 tier.full 이 이겨야 한다. (Task 9 분류 테스트)

---

## 파일 구조

```
e2e-rail/
├── package.json · .claude-plugin/plugin.json · bin/e2e-rail.mjs
├── src/
│   ├── cli.mjs                 # 서브커맨드 디스패치 (2부 Task 15)
│   ├── config.mjs              # loadConfig · appDir · findApp · ConfigError
│   ├── spec-index.mjs          # buildSpecIndex · normalizeRoute · routeMatches · loadOrBuildSpecIndex
│   ├── graph.mjs               # buildGraph · loadOrBuildGraph · affectedEntries · apiLiterals
│   ├── adapters/{index,react-router-lazy,manual}.mjs
│   ├── select.mjs              # classifyFile · computeSelection · select · writeSelection
│   ├── fingerprint.mjs · ledger.mjs · run.mjs · lock.mjs · verify.mjs · shadow.mjs · measure.mjs · shard.mjs  (2부)
│   └── util/{hash,glob,exec,git,ts,playwright}.mjs
├── test/
│   ├── helpers.mjs             # fixtureDir · makeTempRepo · readJson
│   ├── fixtures/sample-app/    # Task 5
│   └── *.test.mjs
```

각 모듈의 공개 함수 이름은 아래 태스크의 **Interfaces** 블록이 정본이다. 2부도 같은 이름을 쓴다.

---

### Task 1: 패키지 스캐폴드와 CLI 진입점

**Files:**
- Create: `package.json`, `.claude-plugin/plugin.json`, `bin/e2e-rail.mjs`, `src/cli.mjs`, `.gitignore`, `LICENSE`, `.github/workflows/ci.yml`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Produces: `main(argv: string[]) => Promise<number>` (`src/cli.mjs`). 종료 코드 규약: 0 성공 · 1 오류 · 2 인자 오류 · 10 select=full · 20 verify=stale · 21 verify=insufficient.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'e2e-rail.mjs');

test('--version prints package version', () => {
  const out = execFileSync('node', [bin, '--version'], { encoding: 'utf8' });
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test('unknown command exits 2 with usage', () => {
  let code = 0;
  try { execFileSync('node', [bin, 'nope'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status; assert.match(e.stderr, /usage/i); }
  assert.equal(code, 2);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/cli.test.mjs`
Expected: FAIL (`bin/e2e-rail.mjs` 없음)

- [ ] **Step 3: 스캐폴드 작성**

```json
// package.json
{
  "name": "e2e-rail",
  "version": "0.1.0",
  "description": "Change-aware selection, verification ledger and sharding for Playwright E2E. Runtime-agnostic core with Claude Code and Codex skill layers.",
  "type": "module",
  "bin": { "e2e-rail": "bin/e2e-rail.mjs" },
  "files": ["bin", "src", "templates", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test",
    "test:contract": "E2E_RAIL_CONTRACT=1 node --test test/contract/",
    "sync:codex": "node scripts/sync-codex.mjs"
  },
  "peerDependencies": { "@playwright/test": ">=1.44", "typescript": ">=5" },
  "peerDependenciesMeta": { "@playwright/test": { "optional": true }, "typescript": { "optional": true } },
  "devDependencies": { "@playwright/test": "^1.61.0", "typescript": "^5.6.0" },
  "license": "MIT",
  "repository": "github:sh5623/e2e-rail"
}
```

```json
// .claude-plugin/plugin.json
{
  "name": "e2e-rail",
  "description": "Change-aware Playwright E2E: select only the specs a change can reach, record every run against a code fingerprint so stale greens are never reused, and shard by measured durations. Skills call the e2e-rail CLI installed in the repo.",
  "version": "0.1.0",
  "author": { "name": "Seungho", "email": "seungho5623@gmail.com" },
  "homepage": "https://github.com/sh5623/e2e-rail",
  "repository": "https://github.com/sh5623/e2e-rail",
  "license": "MIT"
}
```

```js
// bin/e2e-rail.mjs
#!/usr/bin/env node
import { main } from '../src/cli.mjs';
process.exitCode = await main(process.argv.slice(2));
```

```js
// src/cli.mjs  (Task 15 에서 서브커맨드가 채워진다. 지금은 골격만)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const COMMANDS = {};   // name -> async (argv) => exitCode  (Task 15 가 채운다)

export function usage() {
  return [
    'usage: e2e-rail <command> [options]',
    '',
    'commands: init | map | select | run | verify | shadow | measure | shard | lock',
    'options : --version · --help',
  ].join('\n');
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(usage()); return cmd ? 0 : 2; }
  if (cmd === '--version' || cmd === '-v') { console.log(require('../package.json').version); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`unknown command: ${cmd}\n${usage()}`); return 2; }
  try { return await fn(rest); }
  catch (error) { console.error(error?.message ?? error); return 1; }
}
```

```
# .gitignore
/node_modules/
.e2e-rail/
test-results/
*.log
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm test
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:contract
```

`LICENSE` 는 MIT 전문(저작권 `2026 Seungho`). `bin/e2e-rail.mjs` 에 `chmod +x`.

- [ ] **Step 4: 통과 확인**

Run: `npm install && chmod +x bin/e2e-rail.mjs && node --test test/cli.test.mjs`
Expected: PASS 2

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "chore: scaffold e2e-rail package, plugin manifest and CLI entry"
```

---

### Task 2: 유틸 — hash · glob · exec · git

**Files:**
- Create: `src/util/hash.mjs`, `src/util/glob.mjs`, `src/util/exec.mjs`, `src/util/git.mjs`, `test/helpers.mjs`
- Test: `test/util.test.mjs`

**Interfaces:**
- Produces:
  - `sha256(data: string|Buffer): string` · `hashFiles(root: string, relPaths: string[]): string` (정렬 후 `rel\0size\0content` 연결 해시)
  - `globToRegExp(glob: string): RegExp` · `matchGlob(glob, rel): boolean` · `matchAny(globs: string[], rel): boolean` · `walk(rootAbs, {exts?: string[], skipDirs?: string[]}): string[]`(rel, POSIX, 정렬) · `expandGlob(rootAbs, glob): string[]`
  - `execCapture(cmd, args, {cwd, env}) => {status, stdout, stderr}` · `execInherit(cmd, args, {cwd, env}) => Promise<{status, signal}>`
  - `gitHead(root)` · `gitDiffHash(root)` · `gitUntracked(root): string[]` · `gitChangedFiles(root, base, head='HEAD'): string[]|null` · `gitUncommittedFiles(root): string[]`
  - `test/helpers.mjs`: `fixtureDir(name)` · `makeTempRepo(fixtureName) => { root, cleanup() }`(복사 + `git init` + 초기 커밋) · `readJson(abs)`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/util.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { sha256, hashFiles } from '../src/util/hash.mjs';
import { globToRegExp, matchGlob, matchAny, walk, expandGlob } from '../src/util/glob.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { gitHead, gitDiffHash, gitUntracked, gitChangedFiles, gitUncommittedFiles } from '../src/util/git.mjs';
import { makeTempRepo } from './helpers.mjs';

test('sha256 is stable and hex', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.match(sha256('a'), /^[0-9a-f]{64}$/);
});

test('glob: ** and * and ? semantics', () => {
  assert.ok(matchGlob('src/routes/**', 'src/routes/a/b.tsx'));
  assert.ok(matchGlob('**/*.md', 'docs/x/y.md'));
  assert.ok(matchGlob('**/api/bootstrap', '/api/bootstrap'));
  assert.ok(matchGlob('**/api/M3/orm/**', '/api/M3/orm/odr/list'));
  assert.ok(!matchGlob('src/*.ts', 'src/a/b.ts'));
  assert.ok(matchGlob('e2e/support/**', 'e2e/support/auth.ts'));
  assert.ok(matchAny(['a/**', 'b/**'], 'b/c'));
  assert.equal(globToRegExp('x?.ts').test('xa.ts'), true);
});

test('walk and expandGlob return sorted posix relative paths', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const all = walk(root, { exts: ['.ts'] });
    assert.ok(all.includes('src/main.ts'));
    assert.ok(all.every((p) => !p.includes('\\')));
    assert.deepEqual(all, [...all].sort());
    assert.deepEqual(expandGlob(root, 'src/features/*/routes.ts'), ['src/features/cart/routes.ts', 'src/features/orders/routes.ts']);
  } finally { cleanup(); }
});

test('git helpers: head, diff hash changes with edits, untracked, changed files, null on bad base', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const head = gitHead(root);
    assert.match(head, /^[0-9a-f]{40}$/);
    const before = gitDiffHash(root);
    writeFileSync(path.join(root, 'src/main.ts'), '// edited\n', { flag: 'a' });
    assert.notEqual(gitDiffHash(root), before);
    mkdirSync(path.join(root, 'tmpdir'));
    writeFileSync(path.join(root, 'tmpdir/new.ts'), 'export {}\n');
    assert.deepEqual(gitUntracked(root), ['tmpdir/new.ts']);
    assert.deepEqual(gitUncommittedFiles(root).sort(), ['src/main.ts', 'tmpdir/new.ts']);
    execCapture('git', ['commit', '-qam', 'edit'], { cwd: root });
    assert.deepEqual(gitChangedFiles(root, head), ['src/main.ts']);
    assert.equal(gitChangedFiles(root, 'deadbeef'), null);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/util.test.mjs`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

```js
// src/util/hash.mjs
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

export function hashFiles(root, relPaths) {
  const h = createHash('sha256');
  for (const rel of [...relPaths].sort()) {
    const abs = path.join(root, rel);
    const st = statSync(abs);
    h.update(rel).update('\0').update(String(st.size)).update('\0').update(readFileSync(abs)).update('\0');
  }
  return h.digest('hex');
}
```

```js
// src/util/glob.mjs
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const cache = new Map();
export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}
export const matchGlob = (glob, rel) => globToRegExp(glob).test(rel);
export const matchAny = (globs, rel) => globs.some((g) => matchGlob(g, rel));

const DEFAULT_SKIP = new Set(['node_modules', '.git', 'dist', '.e2e-rail', 'test-results', 'playwright-report']);
export function walk(rootAbs, { exts, skipDirs = [] } = {}) {
  const skip = new Set([...DEFAULT_SKIP, ...skipDirs]);
  const out = [];
  const rec = (dirAbs, rel) => {
    for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (!skip.has(ent.name)) rec(path.join(dirAbs, ent.name), r); }
      else if (!exts || exts.includes(path.extname(ent.name))) out.push(r);
    }
  };
  if (statSync(rootAbs, { throwIfNoEntry: false })?.isDirectory()) rec(rootAbs, '');
  return out.sort();
}
export function expandGlob(rootAbs, glob) {
  return walk(rootAbs).filter((rel) => matchGlob(glob, rel));
}
```

```js
// src/util/exec.mjs
import { spawn, spawnSync } from 'node:child_process';

export function execCapture(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: r.error ? 1 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
}
export function execInherit(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', () => resolve({ status: 1, signal: null }));
    child.on('close', (status, signal) => resolve({ status: status ?? 1, signal }));
  });
}
```

```js
// src/util/git.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execCapture } from './exec.mjs';
import { sha256, hashFiles } from './hash.mjs';

const git = (root, args) => execCapture('git', args, { cwd: root });
export function gitHead(root) { return git(root, ['rev-parse', 'HEAD']).stdout.trim(); }
export function gitDiffHash(root) { return sha256(git(root, ['diff', 'HEAD', '--binary', '--no-color']).stdout); }
export function gitUntracked(root) {
  return git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean).sort();
}
export function gitUntrackedHash(root) { return hashFiles(root, gitUntracked(root)); }
export function gitChangedFiles(root, base, head = 'HEAD') {
  if (!base) return null;
  const r = git(root, ['diff', '--no-renames', '--name-only', '-z', `${base}..${head}`, '--']);
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean).sort();
}
export function gitUncommittedFiles(root) {
  const tracked = git(root, ['diff', 'HEAD', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
  return [...new Set([...tracked, ...gitUntracked(root)])].sort();
}
export function readRepoFile(root, rel) { return readFileSync(path.join(root, rel), 'utf8'); }
```

```js
// test/helpers.mjs
import { cpSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCapture } from '../src/util/exec.mjs';

export const fixtureDir = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
export const readJson = (abs) => JSON.parse(readFileSync(abs, 'utf8'));

export function makeTempRepo(fixtureName) {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-rail-'));
  cpSync(fixtureDir(fixtureName), root, { recursive: true });
  const g = (args) => execCapture('git', args, { cwd: root });
  g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  g(['add', '-A']); g(['commit', '-qm', 'init']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
```

`makeTempRepo` 는 Task 5 의 픽스처가 있어야 글롭·git 테스트가 통과한다. 이 태스크에서는 임시로 `test/fixtures/sample-app/src/main.ts`, `src/features/cart/routes.ts`, `src/features/orders/routes.ts` 를 빈 `export {}` 로 만들어 두고 Task 5 에서 실제 내용으로 덮어쓴다.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/util.test.mjs`
Expected: PASS 4

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(util): hash, glob, exec and git helpers with temp-repo test helper"
```

---

### Task 3: 설정 로더 `config.mjs` + 템플릿

**Files:**
- Create: `src/config.mjs`, `templates/e2e-rail.config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `loadConfig(root) => Config`(없으면 `ConfigError`) · `withDefaults(raw, root) => Config` · `appDir(config, app) => abs` · `findApp(config, name) => app`(단일 앱이면 name 생략 가능) · `class ConfigError extends Error`.
- `Config` 형태는 스펙 §3. 기본값: `specDir:'e2e'` · `supportDirs:['e2e/support']` · `srcDir:'src'` · `tsconfig:'tsconfig.json'` · `apiPrefix:'/api'` · `alwaysRun:[]` · `tiers.full` 기본 `['e2e/support/**', <playwrightConfig>, 'package.json']` 에 사용자 값 **추가** · `tiers.ignore:['**/*.test.ts','**/*.test.tsx','**/*.md']` · `run.workers:{local:undefined, ci:1}` · `run.modeEnv:{dev:{}, preview:{E2E_PREVIEW:'1'}}` · `run.env:{}` · `shared:[]` · `ignore:['**/*.md','docs/**']` · `shadow.promoteAfter:3` · `ledger.dir:'.e2e-rail'`.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, appDir, findApp, ConfigError, withDefaults } from '../src/config.mjs';
import { makeTempRepo } from './helpers.mjs';

test('loads fixture config and applies defaults', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const cfg = await loadConfig(root);
    const app = findApp(cfg);
    assert.equal(app.name, 'web');
    assert.equal(appDir(cfg, app), root);
    assert.ok(app.tiers.full.includes('e2e/support/**'));
    assert.ok(app.tiers.full.includes('src/shell/**'));
    assert.equal(app.run.modeEnv.preview.E2E_PREVIEW, '1');
    assert.equal(cfg.shadow.promoteAfter, 2);
  } finally { cleanup(); }
});

test('missing config throws ConfigError; unknown adapter throws', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    rmSync(path.join(root, 'e2e-rail.config.mjs'));
    await assert.rejects(loadConfig(root), ConfigError);
    assert.throws(() => withDefaults({ apps: [{ name: 'x', root: '.', playwrightConfig: 'playwright.config.ts', adapter: { name: 'nope' } }] }, root), /adapter/);
  } finally { cleanup(); }
});

test('findApp requires a name when several apps exist', () => {
  const cfg = withDefaults({ apps: [
    { name: 'a', root: 'apps/a', playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual', map: {} } },
    { name: 'b', root: 'apps/b', playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual', map: {} } },
  ] }, '/tmp/x', { checkFiles: false });
  assert.throws(() => findApp(cfg), /--app/);
  assert.equal(findApp(cfg, 'b').root, 'apps/b');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/config.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// src/config.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class ConfigError extends Error {}
export const CONFIG_FILE = 'e2e-rail.config.mjs';
const ADAPTERS = new Set(['react-router-lazy', 'manual']);

export async function loadConfig(root) {
  const abs = path.join(root, CONFIG_FILE);
  if (!existsSync(abs)) throw new ConfigError(`${CONFIG_FILE} not found in ${root}. Run \`e2e-rail init\` first.`);
  const mod = await import(pathToFileURL(abs).href);
  return withDefaults(mod.default ?? mod, root);
}

export function withDefaults(raw, root, { checkFiles = true } = {}) {
  if (!raw || !Array.isArray(raw.apps) || raw.apps.length === 0) throw new ConfigError('config.apps must be a non-empty array');
  const apps = raw.apps.map((a) => {
    if (!a.name || !a.root || !a.playwrightConfig) throw new ConfigError(`app needs name, root, playwrightConfig: ${JSON.stringify(a)}`);
    if (!a.adapter?.name || !ADAPTERS.has(a.adapter.name)) throw new ConfigError(`app ${a.name}: unknown adapter ${a.adapter?.name}`);
    if (checkFiles && !existsSync(path.join(root, a.root, a.playwrightConfig))) throw new ConfigError(`app ${a.name}: ${a.playwrightConfig} not found under ${a.root}`);
    const specDir = a.specDir ?? 'e2e';
    const supportDirs = a.supportDirs ?? [`${specDir}/support`];
    return {
      ...a, specDir, supportDirs,
      srcDir: a.srcDir ?? 'src', tsconfig: a.tsconfig ?? 'tsconfig.json', apiPrefix: a.apiPrefix ?? '/api',
      alwaysRun: a.alwaysRun ?? [],
      adapter: { basePath: '', routeFiles: [], map: {}, ...a.adapter },
      tiers: {
        full: [...new Set([...supportDirs.map((d) => `${d}/**`), a.playwrightConfig, 'package.json', ...(a.tiers?.full ?? [])])],
        ignore: a.tiers?.ignore ?? ['**/*.test.ts', '**/*.test.tsx', '**/*.md'],
      },
      run: {
        port: a.run?.port, preview: a.run?.preview ?? null,
        workers: { local: a.run?.workers?.local, ci: a.run?.workers?.ci ?? 1 },
        modeEnv: { dev: {}, preview: { E2E_PREVIEW: '1' }, ...(a.run?.modeEnv ?? {}) },
        env: a.run?.env ?? {},
      },
    };
  });
  return {
    root, apps,
    shared: raw.shared ?? [], ignore: raw.ignore ?? ['**/*.md', 'docs/**'],
    shadow: { promoteAfter: raw.shadow?.promoteAfter ?? 3 },
    ledger: { dir: raw.ledger?.dir ?? '.e2e-rail' },
  };
}

export const appDir = (config, app) => path.resolve(config.root, app.root);
export const ledgerDir = (config) => path.join(config.root, config.ledger.dir);
export function findApp(config, name) {
  if (name) { const a = config.apps.find((x) => x.name === name); if (!a) throw new ConfigError(`unknown app ${name}`); return a; }
  if (config.apps.length === 1) return config.apps[0];
  throw new ConfigError(`several apps configured (${config.apps.map((a) => a.name).join(', ')}); pass --app <name>`);
}
```

`templates/e2e-rail.config.mjs` 는 스펙 §3 의 예시를 주석과 함께 그대로 담는다(`apps[0]` 값은 `init` 이 치환할 자리표시 `__APP_NAME__` · `__APP_ROOT__` · `__PW_CONFIG__` 3개만 둔다).

- [ ] **Step 4: 통과 확인**

Run: `node --test test/config.test.mjs`
Expected: PASS 3 (픽스처 `e2e-rail.config.mjs` 는 Task 5 에서 작성. 그 전엔 Task 5 의 설정 파일만 먼저 만들어 둔다)

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(config): load e2e-rail.config.mjs with defaults and validation"
```

---

### Task 4: 호스트 도구 로더 — TypeScript · Playwright CLI · `--list`

**Files:**
- Create: `src/util/ts.mjs`, `src/util/playwright.mjs`, `test/fixtures/sample-app/node_modules/@playwright/test/{package.json,cli.js}`, `test/fixtures/sample-app/stub/{list.json,report-pass.json,report-fail.json}`
- Test: `test/host-tools.test.mjs`

**Interfaces:**
- Produces:
  - `loadTypeScript(appDirAbs) => ts`(앱 → 레포 루트 → e2e-rail 자신의 순서로 `createRequire` 해석) · `readCompilerOptions(ts, appDirAbs, tsconfigRel) => { options, fileNames }` · `parseFile(ts, abs) => SourceFile`(`setParentNodes: true`)
  - `playwrightCli(appDirAbs) => abs path of @playwright/test/cli` · `playwrightVersion(appDirAbs) => string` · `listTests(appDirAbs, configRel) => { [specRelToApp]: string[] /* projects */ }`
- 스텁 Playwright CLI 계약(픽스처 전용): `node cli.js test --list --reporter=json` → `stub/list.json` 출력 · `node cli.js test …` → `process.env.STUB_PW_REPORT`(기본 `stub/report-pass.json`)를 `PLAYWRIGHT_JSON_OUTPUT_NAME` 에 복사, argv 를 `STUB_PW_ARGV_FILE` 에 JSON 으로 기록, 종료 코드 `STUB_PW_RC`(기본 0) · `node cli.js merge-reports <dir>` → `<dir>/index.html` 생성.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/host-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript, readCompilerOptions, parseFile } from '../src/util/ts.mjs';
import { playwrightCli, playwrightVersion, listTests } from '../src/util/playwright.mjs';
import { fixtureDir } from './helpers.mjs';
import path from 'node:path';

const app = fixtureDir('sample-app');

test('loadTypeScript resolves a compiler and reads tsconfig paths', async () => {
  const ts = await loadTypeScript(app);
  assert.equal(typeof ts.createSourceFile, 'function');
  const { options } = readCompilerOptions(ts, app, 'tsconfig.json');
  assert.deepEqual(options.paths['@/*'], ['./src/*']);
  const sf = parseFile(ts, path.join(app, 'src/main.ts'));
  assert.equal(sf.statements.length > 0, true);
});

test('playwright stub is found from the app dir and lists tests per project', () => {
  assert.match(playwrightCli(app), /node_modules\/@playwright\/test\/cli\.js$/);
  assert.equal(playwrightVersion(app), '1.61.0');
  const tests = listTests(app, 'playwright.config.ts');
  assert.deepEqual(tests['e2e/cart.spec.ts'], ['chromium', 'mobile-chrome']);
  assert.deepEqual(tests['e2e/orders.spec.ts'], ['chromium']);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/host-tools.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현과 스텁**

```js
// src/util/ts.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function loadTypeScript(appDirAbs) {
  const candidates = [appDirAbs, process.cwd(), path.dirname(new URL(import.meta.url).pathname)];
  for (const from of candidates) {
    try { return createRequire(path.join(from, 'package.json'))('typescript'); } catch { /* next */ }
  }
  throw new Error('typescript not found. Install it in the app (devDependency) — e2e-rail borrows the host compiler.');
}
export function readCompilerOptions(ts, appDirAbs, tsconfigRel) {
  const cfgPath = path.join(appDirAbs, tsconfigRel);
  const { config, error } = ts.readConfigFile(cfgPath, (p) => readFileSync(p, 'utf8'));
  if (error) throw new Error(`tsconfig: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(cfgPath));
  return { options: parsed.options, fileNames: parsed.fileNames };
}
export function parseFile(ts, abs) {
  return ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
```

```js
// src/util/playwright.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { execCapture } from './exec.mjs';

export function playwrightCli(appDirAbs) {
  return createRequire(path.join(appDirAbs, 'package.json')).resolve('@playwright/test/cli');
}
export function playwrightVersion(appDirAbs) {
  return createRequire(path.join(appDirAbs, 'package.json'))('@playwright/test/package.json').version;
}
/** JSON 리포터의 suite.file 은 config.rootDir 기준이다. 앱 루트 기준으로 되돌린다. */
export function flattenSuites(report, appDirAbs) {
  const rootDir = report.config?.rootDir ?? appDirAbs;
  const out = [];
  const visit = (suite, inherited) => {
    const file = suite.file ? path.relative(appDirAbs, path.resolve(rootDir, suite.file)).split(path.sep).join('/') : inherited;
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) out.push({ file, title: spec.title, project: t.projectName, status: t.status, results: t.results ?? [] });
    for (const s of suite.suites ?? []) visit(s, file);
  };
  for (const s of report.suites ?? []) visit(s, undefined);
  return out;
}
export function listTests(appDirAbs, configRel) {
  const r = execCapture('node', [playwrightCli(appDirAbs), 'test', '--list', '--reporter=json', '--config', configRel], { cwd: appDirAbs });
  if (r.status !== 0) throw new Error(`playwright --list failed:\n${r.stderr || r.stdout}`);
  const report = JSON.parse(r.stdout);
  const map = {};
  for (const t of flattenSuites(report, appDirAbs)) { (map[t.file] ??= []); if (!map[t.file].includes(t.project)) map[t.file].push(t.project); }
  for (const k of Object.keys(map)) map[k].sort();
  return map;
}
```

스텁 Playwright(픽스처 안 `node_modules` 는 `.gitignore` 의 `/node_modules/` 가 루트만 가리키므로 커밋된다):

```json
// test/fixtures/sample-app/node_modules/@playwright/test/package.json
{ "name": "@playwright/test", "version": "1.61.0", "main": "cli.js", "exports": { ".": "./cli.js", "./cli": "./cli.js", "./package.json": "./package.json" } }
```

```js
// test/fixtures/sample-app/node_modules/@playwright/test/cli.js
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const stub = path.join(process.cwd(), 'stub');
const argv = process.argv.slice(2);
if (process.env.STUB_PW_ARGV_FILE) fs.writeFileSync(process.env.STUB_PW_ARGV_FILE, JSON.stringify(argv));
if (argv[0] === 'merge-reports') { const dir = argv[argv.length - 1]; fs.writeFileSync(path.join(dir, 'index.html'), '<html>merged</html>'); process.exit(0); }
if (argv.includes('--list')) { process.stdout.write(fs.readFileSync(path.join(stub, 'list.json'), 'utf8')); process.exit(0); }
const src = process.env.STUB_PW_REPORT || path.join(stub, 'report-pass.json');
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(src, out); }
process.exit(Number(process.env.STUB_PW_RC || 0));
```

```json
// test/fixtures/sample-app/stub/list.json
{ "config": { "rootDir": "<ABS_APP_DIR>/e2e" },
  "suites": [
    { "title": "orders.spec.ts", "file": "orders.spec.ts", "specs": [ { "title": "lists orders", "file": "orders.spec.ts", "tests": [ { "projectName": "chromium", "status": "skipped", "results": [] } ] } ], "suites": [] },
    { "title": "order-detail.spec.ts", "file": "order-detail.spec.ts", "specs": [ { "title": "shows one order", "file": "order-detail.spec.ts", "tests": [ { "projectName": "chromium", "status": "skipped", "results": [] } ] } ], "suites": [] },
    { "title": "cart.spec.ts", "file": "cart.spec.ts", "specs": [ { "title": "adds to cart", "file": "cart.spec.ts", "tests": [ { "projectName": "chromium", "status": "skipped", "results": [] }, { "projectName": "mobile-chrome", "status": "skipped", "results": [] } ] } ], "suites": [] },
    { "title": "smoke.spec.ts", "file": "smoke.spec.ts", "specs": [ { "title": "boots", "file": "smoke.spec.ts", "tests": [ { "projectName": "chromium", "status": "skipped", "results": [] } ] } ], "suites": [] }
  ] }
```

`rootDir` 의 `<ABS_APP_DIR>` 은 스텁이 실행 시 치환한다: `cli.js` 의 `--list` 분기에서 `.replace(/<ABS_APP_DIR>/g, process.cwd())` 를 적용한다(위 코드에 그 한 줄을 넣는다). `report-pass.json` 은 같은 4 spec 에 `status: "expected"`, `results: [{ "status": "passed", "duration": 1200, "retry": 0 }]`(cart 는 두 프로젝트 각각 `duration` 900/1500) 로, `report-fail.json` 은 `orders.spec.ts` 만 `status: "unexpected"`, `results: [{ "status": "failed", "duration": 3000, "retry": 0, "error": { "message": "expect(received).toBeVisible()\nstack…" } }, { "status": "failed", "duration": 2900, "retry": 1, "error": { "message": "expect(received).toBeVisible()" } }]` 로 둔다. `cart.spec.ts` 의 chromium 은 `status: "flaky"`, `results: [{ "status": "failed", "duration": 800, "retry": 0 }, { "status": "passed", "duration": 900, "retry": 1 }]`.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/host-tools.test.mjs`
Expected: PASS 2

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(util): borrow host typescript and playwright; stub playwright cli for tests"
```

---

### Task 5: 픽스처 `sample-app` (소형 react-router 앱 + spec 4 + support 2)

**Files:**
- Create: `test/fixtures/sample-app/` 전체(아래 목록)
- Test: `test/fixture.test.mjs`

**Interfaces:**
- Produces: 이후 모든 태스크가 쓰는 고정 사실.
  - 라우트: `''→src/features/home/HomePage.ts` · `orders→src/features/orders/OrdersPage.ts` · `orders/:id→src/features/orders/OrderDetailPage.ts` · `cart→src/features/cart/routes.ts 의 CartPage`.
  - spec: `orders.spec.ts`(상수 `PAGE` goto + `route('**/api/orders/**')`) · `order-detail.spec.ts`(템플릿 goto + support `orders` import) · `cart.spec.ts`(support `paths` 의 `PATHS.cart` + `@/features/cart/services/cart` 직접 import) · `smoke.spec.ts`(`goto(buildUrl())` → unmapped · alwaysRun).

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/fixture.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fixtureDir } from './helpers.mjs';

const app = fixtureDir('sample-app');
test('fixture has every file later tasks rely on', () => {
  for (const rel of [
    'e2e-rail.config.mjs', 'playwright.config.ts', 'tsconfig.json', 'package.json', 'build.mjs',
    'src/main.ts', 'src/router.ts', 'src/shell/Header.ts', 'src/components/Table.ts', 'src/lib/dead.ts', 'src/store/session.ts',
    'src/features/home/HomePage.ts', 'src/features/orders/routes.ts', 'src/features/orders/OrdersPage.ts', 'src/features/orders/OrderDetailPage.ts', 'src/features/orders/services/orders.ts',
    'src/features/cart/routes.ts', 'src/features/cart/CartPage.ts', 'src/features/cart/services/cart.ts',
    'e2e/orders.spec.ts', 'e2e/order-detail.spec.ts', 'e2e/cart.spec.ts', 'e2e/smoke.spec.ts', 'e2e/support/orders.ts', 'e2e/support/paths.ts',
  ]) assert.ok(existsSync(path.join(app, rel)), rel);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/fixture.test.mjs`
Expected: FAIL

- [ ] **Step 3: 픽스처 작성**

```js
// e2e-rail.config.mjs
export default {
  apps: [{
    name: 'web', root: '.', playwrightConfig: 'playwright.config.ts',
    specDir: 'e2e', supportDirs: ['e2e/support'], srcDir: 'src', tsconfig: 'tsconfig.json',
    adapter: { name: 'react-router-lazy', routeFiles: ['src/features/*/routes.ts', 'src/router.ts'], basePath: '/app' },
    apiPrefix: '/api', alwaysRun: ['smoke'],
    tiers: { full: ['src/main.ts', 'src/router.ts', 'src/shell/**'], ignore: ['**/*.test.ts'] },
    run: { port: 5999, preview: { build: 'node build.mjs', dist: 'dist' }, workers: { local: 2, ci: 1 } },
  }],
  shared: ['packages/**'], ignore: ['**/*.md', 'docs/**'],
  shadow: { promoteAfter: 2 }, ledger: { dir: '.e2e-rail' },
};
```

```ts
// playwright.config.ts  (스텁은 읽지 않는다. 실재만 하면 된다)
export default { testDir: './e2e', projects: [{ name: 'chromium' }, { name: 'mobile-chrome', testMatch: ['**/cart.spec.ts'] }] };
```
```json
// tsconfig.json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, "strict": true, "noEmit": true }, "include": ["src", "e2e"] }
```
```json
// package.json
{ "name": "sample-app", "private": true, "type": "module" }
```
```js
// build.mjs  — preview 모드 테스트용 가짜 빌드
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', `<html>${Date.now()}</html>`);
```
```ts
// src/main.ts
import { router } from './router';
import { Header } from './shell/Header';
import { session } from '@/store/session';
export const app = { router, Header, session };
```
```ts
// src/router.ts
import { ordersRoutes } from '@/features/orders/routes';
import { cartRoutes } from '@/features/cart/routes';
export const router = [{
  path: '/app',
  lazy: async () => ({ Component: (await import('@/features/home/HomePage')).HomePage }),
  children: [...ordersRoutes, ...cartRoutes],
}];
```
```ts
// src/shell/Header.ts
export const Header = () => 'header';
// src/store/session.ts
export const session = { user: null as null | string };
// src/components/Table.ts
export const Table = (rows: unknown[]) => rows.length;
// src/lib/dead.ts
export const dead = 1;
// src/features/home/HomePage.ts
export const HomePage = () => 'home';
```
```ts
// src/features/orders/routes.ts
export const ordersRoutes = [
  { path: 'orders', lazy: async () => ({ Component: (await import('@/features/orders/OrdersPage')).OrdersPage }) },
  { path: 'orders/:id', lazy: async () => ({ Component: (await import('@/features/orders/OrderDetailPage')).OrderDetailPage }) },
];
// src/features/orders/OrdersPage.ts
import { Table } from '@/components/Table';
import { listOrders } from './services/orders';
export const OrdersPage = async () => Table(await listOrders());
// src/features/orders/OrderDetailPage.ts
import { getOrder } from './services/orders';
export const OrderDetailPage = (id: string) => getOrder(id);
// src/features/orders/services/orders.ts
export const listOrders = async () => fetch('/api/orders/list').then((r) => r.json() as Promise<unknown[]>);
export const getOrder = async (id: string) => fetch(`/api/orders/${id}`).then((r) => r.json());
```
```ts
// src/features/cart/routes.ts
export const cartRoutes = [
  { path: 'cart', lazy: async () => ({ Component: (await import('@/features/cart/CartPage')).CartPage }) },
];
// src/features/cart/CartPage.ts
import { Table } from '@/components/Table';
import { addToCart } from './services/cart';
export const CartPage = async () => Table([await addToCart('p1')]);
// src/features/cart/services/cart.ts
export const addToCart = async (id: string) => fetch('/api/cart/add', { method: 'POST', body: id });
```
```ts
// e2e/orders.spec.ts
import { test, expect } from '@playwright/test';
const PAGE = '/app/orders?tab=all';
test('lists orders', async ({ page }) => {
  await page.route('**/api/orders/**', (r) => r.fulfill({ json: [] }));
  await page.goto(PAGE);
  await expect(page.getByRole('table')).toBeVisible();
});
// e2e/order-detail.spec.ts
import { test, expect } from '@playwright/test';
import { mockOrders } from './support/orders';
test('shows one order', async ({ page }) => {
  await mockOrders(page);
  const id = '123';
  await page.goto(`/app/orders/${id}`);
  await expect(page.getByText('order')).toBeVisible();
});
// e2e/cart.spec.ts
import { test, expect } from '@playwright/test';
import { PATHS } from './support/paths';
import { addToCart } from '@/features/cart/services/cart';
test('adds to cart', async ({ page }) => {
  void addToCart;
  await page.route('**/api/cart/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.goto(PATHS.cart);
  await expect(page.getByRole('table')).toBeVisible();
});
// e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';
const buildUrl = () => '/app/';
test('boots', async ({ page }) => {
  await page.goto(buildUrl());
  await expect(page).toHaveTitle(/.*/);
});
// e2e/support/orders.ts
import type { Page } from '@playwright/test';
export const ORDER_PATHS = { list: '/app/orders' } as const;
export async function mockOrders(page: Page) {
  await page.route('**/api/orders/list', (r) => r.fulfill({ json: [] }));
}
// e2e/support/paths.ts
export const PATHS = { cart: '/app/cart', home: '/app/' };
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/fixture.test.mjs test/util.test.mjs test/config.test.mjs test/host-tools.test.mjs`
Expected: PASS 전부

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "test: add sample-app fixture (react-router routes, 4 specs, support helpers)"
```

---

### Task 6: spec 인덱스 `spec-index.mjs`

**Files:**
- Create: `src/spec-index.mjs`
- Test: `test/spec-index.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeRoute(raw: string, basePath: string): string` · `routeMatches(routerPath: string, specRoute: string): boolean`
  - `buildSpecIndex({ config, app, ts, tests }) => SpecIndex` where `SpecIndex = { generatedAt, key, specs: { [specRel]: { routes: string[], apis: string[], imports: string[], supports: string[], projects: string[], unmapped: boolean } } }`
  - `specIndexKey({ config, app }) => string`(spec·support 파일 내용 + playwright config 해시) · `loadOrBuildSpecIndex({ config, app, ts }) => SpecIndex`(캐시 `.e2e-rail/map.<app>.json`)
  - `slugOf(specRel) => 'orders'`(파일명에서 `.spec.ts` 제거)

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/spec-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoute, routeMatches, buildSpecIndex, loadOrBuildSpecIndex, slugOf } from '../src/spec-index.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { listTests } from '../src/util/playwright.mjs';
import { makeTempRepo } from './helpers.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

test('normalizeRoute strips basePath, query, slashes', () => {
  assert.equal(normalizeRoute('/app/orders?tab=1#x', '/app'), 'orders');
  assert.equal(normalizeRoute('/app/', '/app'), '');
  assert.equal(normalizeRoute('/other/x', '/app'), 'other/x');
});

test('routeMatches: params, wildcards, splat, length', () => {
  assert.ok(routeMatches('orders/:id', 'orders/123'));
  assert.ok(routeMatches('orders/:id', 'orders/*'));
  assert.ok(!routeMatches('orders', 'orders/123'));
  assert.ok(!routeMatches('orders/:id', 'orders'));
  assert.ok(routeMatches('files/*', 'files/a/b/c'));
  assert.ok(routeMatches('', ''));
});

test('buildSpecIndex resolves literal, const, imported object, template and unmapped gotos', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const idx = buildSpecIndex({ config, app, ts, tests: listTests(root, app.playwrightConfig) });
    const s = idx.specs;
    assert.deepEqual(s['e2e/orders.spec.ts'].routes, ['orders']);
    assert.deepEqual(s['e2e/orders.spec.ts'].apis, ['**/api/orders/**']);
    assert.deepEqual(s['e2e/order-detail.spec.ts'].routes, ['orders/*']);
    assert.deepEqual(s['e2e/order-detail.spec.ts'].apis, ['**/api/orders/list']);     // support 모듈의 route() 합집합
    assert.deepEqual(s['e2e/order-detail.spec.ts'].supports, ['e2e/support/orders.ts']);
    assert.deepEqual(s['e2e/cart.spec.ts'].routes, ['cart']);
    assert.deepEqual(s['e2e/cart.spec.ts'].imports, ['src/features/cart/services/cart.ts']);
    assert.deepEqual(s['e2e/cart.spec.ts'].projects, ['chromium', 'mobile-chrome']);
    assert.equal(s['e2e/smoke.spec.ts'].unmapped, true);
    assert.deepEqual(s['e2e/smoke.spec.ts'].routes, []);
    assert.equal(slugOf('e2e/order-detail.spec.ts'), 'order-detail');
  } finally { cleanup(); }
});

test('loadOrBuildSpecIndex caches by content key and rebuilds after a spec edit', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const a = await loadOrBuildSpecIndex({ config, app, ts });
    assert.ok(existsSync(path.join(root, '.e2e-rail/map.web.json')));
    const b = await loadOrBuildSpecIndex({ config, app, ts });
    assert.equal(a.key, b.key);
    writeFileSync(path.join(root, 'e2e/smoke.spec.ts'), "import { test } from '@playwright/test';\ntest('b', async ({ page }) => { await page.goto('/app/'); });\n");
    const c = await loadOrBuildSpecIndex({ config, app, ts });
    assert.notEqual(c.key, a.key);
    assert.deepEqual(c.specs['e2e/smoke.spec.ts'].routes, ['']);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/spec-index.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// src/spec-index.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { hashFiles } from './util/hash.mjs';
import { walk, matchAny } from './util/glob.mjs';
import { parseFile } from './util/ts.mjs';
import { listTests } from './util/playwright.mjs';

export const slugOf = (rel) => path.posix.basename(rel).replace(/\.spec\.[cm]?[tj]sx?$/, '');

export function normalizeRoute(raw, basePath) {
  let r = String(raw).replace(/[?#].*$/, '');
  if (basePath && (r === basePath || r.startsWith(`${basePath}/`))) r = r.slice(basePath.length);
  return r.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function routeMatches(routerPath, specRoute) {
  const a = routerPath.split('/').filter(Boolean);
  const b = specRoute.split('/').filter(Boolean);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === '*') return true;
    if (x === undefined || y === undefined) return false;
    if (x.startsWith(':') || y === '*' || x === y) continue;
    return false;
  }
  return true;
}

const EXTS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '/index.ts', '/index.tsx'];
function resolveRel(dirAbs, baseRel, spec) {
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(baseRel), spec));
  for (const ext of ['', ...EXTS]) { const rel = candidate + ext; if (existsSync(path.join(dirAbs, rel))) return rel; }
  return null;
}

/** 파일 하나의 «문자열 식 해석기». depth 는 import 추적 단계(최대 1). */
function makeResolver(ts, sf, loadModule, depth = 0) {
  const consts = new Map(); const imports = new Map();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings))
      for (const el of st.importClause.namedBindings.elements) imports.set(el.name.text, { module: st.moduleSpecifier.text, exported: (el.propertyName ?? el.name).text });
  }
  const unwrap = (n) => (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || (ts.isSatisfiesExpression?.(n) ?? false) || ts.isNonNullExpression(n)) ? unwrap(n.expression) : n;
  const api = {
    resolveString(node) {
      const n = unwrap(node);
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
      if (ts.isTemplateExpression(n)) { let out = n.head.text; for (const sp of n.templateSpans) out += (api.resolveString(sp.expression) ?? '*') + sp.literal.text; return out; }
      if (ts.isIdentifier(n)) {
        if (consts.has(n.text)) return api.resolveString(consts.get(n.text));
        const imp = imports.get(n.text);
        if (imp && depth < 1) { const other = loadModule(imp.module, depth + 1); return other?.resolveExport(imp.exported) ?? null; }
        return null;
      }
      if (ts.isPropertyAccessExpression(n)) {
        const obj = api.resolveObject(n.expression);
        if (!obj) return null;
        const prop = obj.properties.find((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === n.name.text);
        return prop ? api.resolveString(prop.initializer) : null;
      }
      return null;
    },
    resolveObject(node) {
      const n = unwrap(node);
      if (ts.isObjectLiteralExpression(n)) return n;
      if (ts.isIdentifier(n)) {
        if (consts.has(n.text)) return api.resolveObject(consts.get(n.text));
        const imp = imports.get(n.text);
        if (imp && depth < 1) { const other = loadModule(imp.module, depth + 1); return other?.exportObject(imp.exported) ?? null; }
      }
      return null;
    },
    resolveExport: (name) => (consts.has(name) ? api.resolveString(consts.get(name)) : null),
    exportObject: (name) => (consts.has(name) ? api.resolveObject(consts.get(name)) : null),
    imports,
  };
  return api;
}

function collectCalls(ts, sf, methodName) {
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === methodName && n.arguments[0]) out.push(n.arguments[0]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function indexSpec({ ts, dirAbs, app, specRel, tests }) {
  const sf = parseFile(ts, path.join(dirAbs, specRel));
  const supports = new Set(); const imports = new Set();
  const inSupport = (rel) => app.supportDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
  const toRel = (fromRel, spec) => {
    if (spec.startsWith('@/')) return resolveRel(dirAbs, `${app.srcDir}/x`, `./${spec.slice(2)}`);
    if (spec.startsWith('.')) return resolveRel(dirAbs, fromRel, spec);
    return null;
  };
  const loadModule = (spec, depth) => {
    const rel = toRel(specRel, spec);
    if (!rel || !inSupport(rel)) return null;
    return makeResolver(ts, parseFile(ts, path.join(dirAbs, rel)), () => null, depth);
  };
  const resolver = makeResolver(ts, sf, loadModule);
  for (const [, imp] of resolver.imports) { const rel = toRel(specRel, imp.module); if (!rel) continue; if (inSupport(rel)) supports.add(rel); else if (rel.startsWith(`${app.srcDir}/`)) imports.add(rel); }
  for (const st of sf.statements) if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) { const rel = toRel(specRel, st.moduleSpecifier.text); if (rel && inSupport(rel)) supports.add(rel); else if (rel?.startsWith(`${app.srcDir}/`)) imports.add(rel); }
  const routes = new Set();
  for (const arg of collectCalls(ts, sf, 'goto')) { const v = resolver.resolveString(arg); if (v !== null) routes.add(normalizeRoute(v, app.adapter.basePath)); }
  const apis = new Set();
  const apiFiles = [specRel]; const seen = new Set(supports);
  const queue = [...supports];
  while (queue.length) { const rel = queue.shift(); apiFiles.push(rel); const s = parseFile(ts, path.join(dirAbs, rel)); for (const st of s.statements) if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) { const r = toRel(rel, st.moduleSpecifier.text); if (r && inSupport(r) && !seen.has(r)) { seen.add(r); queue.push(r); } } }
  for (const rel of apiFiles) { const s = rel === specRel ? sf : parseFile(ts, path.join(dirAbs, rel)); const r = rel === specRel ? resolver : makeResolver(ts, s, () => null, 1); for (const arg of collectCalls(ts, s, 'route')) { const v = r.resolveString(arg); if (v) apis.add(v); } }
  return { routes: [...routes].sort(), apis: [...apis].sort(), imports: [...imports].sort(), supports: [...supports].sort(), projects: tests[specRel] ?? [], unmapped: routes.size === 0 };
}

export function specFiles(config, app) {
  const dirAbs = appDir(config, app);
  return walk(path.join(dirAbs, app.specDir), { exts: ['.ts', '.tsx', '.mts', '.js', '.mjs'] }).map((r) => `${app.specDir}/${r}`).filter((r) => /\.spec\.[cm]?[tj]sx?$/.test(r));
}
export function specIndexKey({ config, app }) {
  const dirAbs = appDir(config, app);
  const files = [...specFiles(config, app), ...app.supportDirs.flatMap((d) => walk(path.join(dirAbs, d)).map((r) => `${d}/${r}`)), app.playwrightConfig];
  return hashFiles(dirAbs, files.filter((f) => existsSync(path.join(dirAbs, f))));
}
export function buildSpecIndex({ config, app, ts, tests }) {
  const dirAbs = appDir(config, app);
  const specs = {};
  for (const specRel of specFiles(config, app)) if (!matchAny(app.tiers.ignore, specRel)) specs[specRel] = indexSpec({ ts, dirAbs, app, specRel, tests });
  return { generatedAt: new Date().toISOString(), key: specIndexKey({ config, app }), specs };
}
export async function loadOrBuildSpecIndex({ config, app, ts }) {
  const cacheAbs = path.join(ledgerDir(config), `map.${app.name}.json`);
  const key = specIndexKey({ config, app });
  if (existsSync(cacheAbs)) { const cached = JSON.parse(readFileSync(cacheAbs, 'utf8')); if (cached.key === key) return cached; }
  const idx = buildSpecIndex({ config, app, ts, tests: listTests(appDir(config, app), app.playwrightConfig) });
  mkdirSync(path.dirname(cacheAbs), { recursive: true });
  writeFileSync(cacheAbs, JSON.stringify(idx, null, 2));
  return idx;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/spec-index.test.mjs`
Expected: PASS 4

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(index): spec index — goto/route resolution through consts, imports and templates"
```

---

### Task 7: 어댑터 — `react-router-lazy` · `manual` · 레지스트리

**Files:**
- Create: `src/adapters/index.mjs`, `src/adapters/react-router-lazy.mjs`, `src/adapters/manual.mjs`
- Test: `test/adapters.test.mjs`

**Interfaces:**
- Produces: `getAdapter(name) => Adapter` · `Adapter = { name, routeEntries({ config, app, ts }) => { entries: Array<{ route: string, file: string /* rel to app */ }>, unresolved: string[] } }`.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/adapters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAdapter } from '../src/adapters/index.mjs';
import { loadConfig, findApp, withDefaults } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { makeTempRepo } from './helpers.mjs';

test('react-router-lazy extracts path + lazy import pairs, nested children, basePath-stripped', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const { entries, unresolved } = getAdapter('react-router-lazy').routeEntries({ config, app, ts });
    assert.deepEqual(unresolved, []);
    assert.deepEqual(entries.sort((a, b) => a.route.localeCompare(b.route)), [
      { route: '', file: 'src/features/home/HomePage.ts' },
      { route: 'cart', file: 'src/features/cart/CartPage.ts' },
      { route: 'orders', file: 'src/features/orders/OrdersPage.ts' },
      { route: 'orders/:id', file: 'src/features/orders/OrderDetailPage.ts' },
    ]);
  } finally { cleanup(); }
});

test('non-literal path or import lands in unresolved', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    writeFileSync(path.join(root, 'src/features/cart/routes.ts'), "const BASE = 'cart';\nexport const cartRoutes = [{ path: `${BASE}/x`, lazy: async () => ({ Component: (await import('@/features/cart/CartPage')).CartPage }) }];\n");
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const { unresolved } = getAdapter('react-router-lazy').routeEntries({ config, app, ts });
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0], /cart\/routes\.ts/);
  } finally { cleanup(); }
});

test('manual adapter returns the configured map', () => {
  const config = withDefaults({ apps: [{ name: 'a', root: '.', playwrightConfig: 'p.ts', adapter: { name: 'manual', map: { orders: ['src/pages/Orders.tsx', 'src/pages/Orders2.tsx'] } } }] }, '/x', { checkFiles: false });
  const { entries, unresolved } = getAdapter('manual').routeEntries({ config, app: config.apps[0] });
  assert.deepEqual(entries, [{ route: 'orders', file: 'src/pages/Orders.tsx' }, { route: 'orders', file: 'src/pages/Orders2.tsx' }]);
  assert.deepEqual(unresolved, []);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/adapters.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// src/adapters/index.mjs
import { reactRouterLazy } from './react-router-lazy.mjs';
import { manual } from './manual.mjs';
const REGISTRY = { [reactRouterLazy.name]: reactRouterLazy, [manual.name]: manual };
export function getAdapter(name) { const a = REGISTRY[name]; if (!a) throw new Error(`unknown adapter: ${name}`); return a; }
export const adapterNames = () => Object.keys(REGISTRY);
```

```js
// src/adapters/manual.mjs
export const manual = {
  name: 'manual',
  routeEntries({ app }) {
    const entries = [];
    for (const [route, files] of Object.entries(app.adapter.map ?? {})) for (const file of files) entries.push({ route, file });
    return { entries, unresolved: [] };
  },
};
```

```js
// src/adapters/react-router-lazy.mjs
import path from 'node:path';
import { appDir } from '../config.mjs';
import { expandGlob } from '../util/glob.mjs';
import { parseFile, readCompilerOptions } from '../util/ts.mjs';
import { normalizeRoute } from '../spec-index.mjs';

export const reactRouterLazy = {
  name: 'react-router-lazy',
  routeEntries({ config, app, ts }) {
    const dirAbs = appDir(config, app);
    const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
    const entries = []; const unresolved = [];
    const prop = (obj, name) => obj.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name)?.initializer;
    const firstImport = (node) => { let found = null; const visit = (n) => { if (found) return; if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0]) { found = ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : '__dynamic__'; return; } ts.forEachChild(n, visit); }; visit(node); return found; };
    const resolveModule = (spec, fromAbs) => { const r = ts.resolveModuleName(spec, fromAbs, options, ts.sys).resolvedModule; return r && !r.isExternalLibraryImport ? path.relative(dirAbs, r.resolvedFileName).split(path.sep).join('/') : null; };
    for (const rel of app.adapter.routeFiles.flatMap((g) => expandGlob(dirAbs, g))) {
      const abs = path.join(dirAbs, rel); const sf = parseFile(ts, abs);
      const walk = (node, prefix) => {
        if (ts.isObjectLiteralExpression(node) && prop(node, 'path')) {
          const p = prop(node, 'path');
          if (!ts.isStringLiteral(p) && !ts.isNoSubstitutionTemplateLiteral(p)) { unresolved.push(`${rel}: non-literal path at ${sf.getLineAndCharacterOfPosition(p.pos).line + 1}`); return; }
          const full = normalizeRoute(path.posix.join(prefix, p.text), app.adapter.basePath);
          const lazy = prop(node, 'lazy');
          if (lazy) { const spec = firstImport(lazy); if (!spec || spec === '__dynamic__') unresolved.push(`${rel}: lazy without literal import() for path ${full}`); else { const file = resolveModule(spec, abs); if (file) entries.push({ route: full, file }); else unresolved.push(`${rel}: cannot resolve ${spec}`); } }
          const children = prop(node, 'children');
          if (children && ts.isArrayLiteralExpression(children)) for (const el of children.elements) walk(el, full);
          return;
        }
        ts.forEachChild(node, (c) => walk(c, prefix));
      };
      walk(sf, '');
    }
    return { entries, unresolved };
  },
};
```

주의: `prefix` 는 `basePath` 가 떼어진 상대 접두다. `path: '/app'` 처럼 절대 path 는 `normalizeRoute` 가 `basePath` 를 떼어 `''` 로 만든다.

- [ ] **Step 4: 통과 확인**

Run: `node --test test/adapters.test.mjs`
Expected: PASS 3

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(adapters): react-router-lazy route parser and manual map adapter"
```

---

### Task 8: 역방향 import 그래프 `graph.mjs`

**Files:**
- Create: `src/graph.mjs`
- Test: `test/graph.test.mjs`

**Interfaces:**
- Produces:
  - `buildGraph({ config, app, ts }) => { key, files: string[], reverse: { [rel]: string[] } }` · `graphKey({ config, app }) => string`(src 파일 목록 + mtime) · `loadOrBuildGraph({ config, app, ts })`(캐시 `.e2e-rail/graph.<app>.json`)
  - `affectedEntries(graph, changedRel: string[], entryRel: string[], mainRel: string|null) => { entries: Set<string>, unresolved: string[], mainOnly: string[] }`
  - `apiLiterals(abs: string, apiPrefix: string) => string[]`(파일 안 `'<apiPrefix>/…'` 리터럴 · 템플릿은 첫 `${` 앞까지 + `*`)
  - `findMain(config, app) => rel|null`(`src/main.{tsx,ts}` 또는 `src/index.{tsx,ts}` 첫 실재)

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/graph.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildGraph, affectedEntries, apiLiterals, loadOrBuildGraph, findMain } from '../src/graph.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { makeTempRepo, fixtureDir } from './helpers.mjs';

const ENTRIES = ['src/features/home/HomePage.ts', 'src/features/orders/OrdersPage.ts', 'src/features/orders/OrderDetailPage.ts', 'src/features/cart/CartPage.ts'];

test('reverse edges follow static, aliased and dynamic imports', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const g = buildGraph({ config, app, ts });
    assert.deepEqual(g.reverse['src/components/Table.ts'].sort(), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(g.reverse['src/features/orders/OrdersPage.ts'], ['src/features/orders/routes.ts']);   // dynamic import()
    assert.deepEqual(g.reverse['src/store/session.ts'], ['src/main.ts']);
    assert.equal(findMain(config, app), 'src/main.ts');
  } finally { cleanup(); }
});

test('affectedEntries: entries, main-only and unresolved', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const g = buildGraph({ config, app, ts });
    const r1 = affectedEntries(g, ['src/features/orders/services/orders.ts'], ENTRIES, 'src/main.ts');
    assert.deepEqual([...r1.entries].sort(), ['src/features/orders/OrderDetailPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(r1.unresolved, []); assert.deepEqual(r1.mainOnly, []);
    const r2 = affectedEntries(g, ['src/store/session.ts'], ENTRIES, 'src/main.ts');
    assert.deepEqual(r2.mainOnly, ['src/store/session.ts']); assert.equal(r2.entries.size, 0);
    const r3 = affectedEntries(g, ['src/lib/dead.ts', 'src/gone/deleted.ts'], ENTRIES, 'src/main.ts');
    assert.deepEqual(r3.unresolved, ['src/lib/dead.ts', 'src/gone/deleted.ts']);
    const r4 = affectedEntries(g, ['src/features/cart/CartPage.ts'], ENTRIES, 'src/main.ts');
    assert.deepEqual([...r4.entries], ['src/features/cart/CartPage.ts']);
  } finally { cleanup(); }
});

test('apiLiterals extracts prefixed literals and template prefixes', () => {
  const abs = path.join(fixtureDir('sample-app'), 'src/features/orders/services/orders.ts');
  assert.deepEqual(apiLiterals(abs, '/api'), ['/api/orders/*', '/api/orders/list']);
});

test('loadOrBuildGraph caches and invalidates on mtime change', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const a = await loadOrBuildGraph({ config, app, ts }); const b = await loadOrBuildGraph({ config, app, ts });
    assert.equal(a.key, b.key);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/graph.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// src/graph.mjs
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { sha256 } from './util/hash.mjs';
import { walk } from './util/glob.mjs';
import { parseFile, readCompilerOptions } from './util/ts.mjs';

const SRC_EXTS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];
export function srcFiles(config, app) {
  const dirAbs = appDir(config, app);
  return walk(path.join(dirAbs, app.srcDir), { exts: SRC_EXTS }).map((r) => `${app.srcDir}/${r}`);
}
export function graphKey({ config, app }) {
  const dirAbs = appDir(config, app);
  return sha256(srcFiles(config, app).map((r) => `${r}:${statSync(path.join(dirAbs, r)).mtimeMs}`).join('\n'));
}
export function findMain(config, app) {
  const dirAbs = appDir(config, app);
  for (const c of ['main.tsx', 'main.ts', 'index.tsx', 'index.ts']) { const rel = `${app.srcDir}/${c}`; if (existsSync(path.join(dirAbs, rel))) return rel; }
  return null;
}
function importSpecifiers(ts, sf) {
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
export function buildGraph({ config, app, ts }) {
  const dirAbs = appDir(config, app);
  const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
  const files = srcFiles(config, app);
  const reverse = Object.fromEntries(files.map((f) => [f, []]));
  for (const rel of files) {
    const abs = path.join(dirAbs, rel);
    for (const spec of importSpecifiers(ts, parseFile(ts, abs))) {
      const r = ts.resolveModuleName(spec, abs, options, ts.sys).resolvedModule;
      if (!r || r.isExternalLibraryImport) continue;
      const dep = path.relative(dirAbs, r.resolvedFileName).split(path.sep).join('/');
      (reverse[dep] ??= []).push(rel);
    }
  }
  for (const k of Object.keys(reverse)) reverse[k] = [...new Set(reverse[k])].sort();
  return { key: graphKey({ config, app }), files, reverse };
}
export async function loadOrBuildGraph({ config, app, ts }) {
  const cacheAbs = path.join(ledgerDir(config), `graph.${app.name}.json`);
  const key = graphKey({ config, app });
  if (existsSync(cacheAbs)) { const cached = JSON.parse(readFileSync(cacheAbs, 'utf8')); if (cached.key === key) return cached; }
  const g = buildGraph({ config, app, ts });
  mkdirSync(path.dirname(cacheAbs), { recursive: true });
  writeFileSync(cacheAbs, JSON.stringify(g));
  return g;
}
export function affectedEntries(graph, changedRel, entryRel, mainRel) {
  const entrySet = new Set(entryRel);
  const entries = new Set(); const unresolved = []; const mainOnly = [];
  for (const start of changedRel) {
    if (!(start in graph.reverse)) { unresolved.push(start); continue; }
    const seen = new Set([start]); const queue = [start]; let hit = false; let main = false;
    while (queue.length) {
      const f = queue.shift();
      if (entrySet.has(f)) { entries.add(f); hit = true; }
      if (f === mainRel) main = true;
      for (const p of graph.reverse[f] ?? []) if (!seen.has(p)) { seen.add(p); queue.push(p); }
    }
    if (!hit && !main) unresolved.push(start);
    else if (!hit && main) mainOnly.push(start);
  }
  return { entries, unresolved, mainOnly };
}
export function apiLiterals(abs, apiPrefix) {
  const src = readFileSync(abs, 'utf8');
  const out = new Set();
  const esc = apiPrefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const m of src.matchAll(new RegExp(`['"](${esc}/[^'"\\s]*)['"]`, 'g'))) out.add(m[1]);
  for (const m of src.matchAll(new RegExp('`(' + esc + '/[^`]*)`', 'g'))) { const i = m[1].indexOf('${'); out.add(i >= 0 ? `${m[1].slice(0, i)}*` : m[1]); }
  return [...out].sort();
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/graph.test.mjs`
Expected: PASS 4

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(graph): reverse import graph with cache, affected-entry BFS and API literal extraction"
```

---

### Task 9: 선택기 `select.mjs` — 규칙표 · test-list · add/remove

**Files:**
- Create: `src/select.mjs`
- Test: `test/select.test.mjs`

**Interfaces:**
- Produces:
  - `classifyFile(config, repoRel) => { kind: 'ignore'|'shared'|'unknown-root'|'tier-full'|'spec'|'support'|'src'|'app-other', app?: AppConfig, appRel?: string, reason: string }`
  - `computeSelection({ config, changedFiles: string[]|null, base, head, includeUncommitted, ctx }) => Selection` where `ctx.forApp(app) => Promise<{ index: SpecIndex, graph, entries: Array<{route,file}>, unresolvedEntries: string[], main: string|null }>`
  - `select({ config, ts, base, head, includeUncommitted, app? }) => Selection`(git + 실제 빌더로 `ctx` 구성)
  - `writeSelection(config, selection) => { selectionAbs, testLists: { [app]: abs|null } }`(`.e2e-rail/selection.json` + `.e2e-rail/selections/<id>.json` + `.e2e-rail/test-list.<app>.txt`)
  - `amendSelection(config, { app, add: [{spec, reason}], remove: [{spec, reason}], allowRemove: boolean })`
  - `selectionExitCode(selection) => 0|10`
  - `Selection = { id, createdAt, base, head, includeUncommitted, changedFiles, codeId, apps: { [name]: { mode: 'full'|'partial', reasons: string[], specs: [{ file, projects, reasons }], added: [], removed: [], unmappedIncluded: number, changedFiles: string[] } } }`

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/select.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { classifyFile, computeSelection, select, writeSelection, amendSelection, selectionExitCode } from '../src/select.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { makeTempRepo } from './helpers.mjs';

async function setup() {
  const t = makeTempRepo('sample-app');
  const config = await loadConfig(t.root); const ts = await loadTypeScript(t.root);
  return { ...t, config, ts };
}
const files = (sel) => sel.apps.web.specs.map((s) => s.file).sort();

test('classifyFile follows the table top-down (tier-full beats src)', async () => {
  const { root, config, cleanup } = await setup();
  try {
    assert.equal(classifyFile(config, 'README.md').kind, 'ignore');
    assert.equal(classifyFile(config, 'packages/ui/x.ts').kind, 'shared');
    assert.equal(classifyFile(config, 'scripts/x.mjs').kind, 'unknown-root');
    assert.equal(classifyFile(config, 'src/shell/Header.ts').kind, 'tier-full');
    assert.equal(classifyFile(config, 'src/router.ts').kind, 'tier-full');
    assert.equal(classifyFile(config, 'e2e/cart.spec.ts').kind, 'spec');
    assert.equal(classifyFile(config, 'e2e/support/paths.ts').kind, 'tier-full');
    assert.equal(classifyFile(config, 'src/components/Table.ts').kind, 'src');
    assert.equal(classifyFile(config, 'vite.config.ts').kind, 'app-other');
    assert.equal(classifyFile(config, 'src/x.test.ts').kind, 'ignore');
  } finally { cleanup(); }
});

test('null changed files → every app full', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    const sel = await select({ config, ts, base: 'deadbeef' });
    assert.equal(sel.apps.web.mode, 'full');
    assert.equal(selectionExitCode(sel), 10);
  } finally { cleanup(); }
});

test('service change selects route consumers + api matches; unmapped and alwaysRun ride along', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    const sel = await computeSelection({ config, changedFiles: ['src/features/orders/services/orders.ts'], ctx: await realCtx(config, ts) });
    assert.equal(sel.apps.web.mode, 'partial');
    assert.deepEqual(files(sel), ['e2e/order-detail.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts']);
    assert.equal(sel.apps.web.unmappedIncluded, 1);
    const orders = sel.apps.web.specs.find((s) => s.file === 'e2e/orders.spec.ts');
    assert.ok(orders.reasons.some((r) => r.startsWith('route:orders')));
    assert.ok(orders.reasons.some((r) => r.startsWith('api:**/api/orders/**')));
  } finally { cleanup(); }
});

test('shared component change selects every consuming route; direct import selects spec', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    const ctx = await realCtx(config, ts);
    const a = await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx });
    assert.deepEqual(files(a), ['e2e/cart.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts']);
    const b = await computeSelection({ config, changedFiles: ['src/features/cart/services/cart.ts'], ctx });
    const cart = b.apps.web.specs.find((s) => s.file === 'e2e/cart.spec.ts');
    assert.ok(cart.reasons.some((r) => r.startsWith('import:src/features/cart/services/cart.ts')));
    assert.deepEqual(cart.projects, ['chromium', 'mobile-chrome']);
  } finally { cleanup(); }
});

test('main-only, unresolved, tier-full and app-other widen to full with reasons', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    const ctx = await realCtx(config, ts);
    for (const [file, re] of [['src/store/session.ts', /graph-main-only/], ['src/lib/dead.ts', /graph-unresolved/], ['src/shell/Header.ts', /tier-full/], ['vite.config.ts', /app-other/]]) {
      const sel = await computeSelection({ config, changedFiles: [file], ctx });
      assert.equal(sel.apps.web.mode, 'full', file);
      assert.ok(sel.apps.web.reasons.some((r) => re.test(r)), file);
    }
    const spec = await computeSelection({ config, changedFiles: ['e2e/cart.spec.ts'], ctx });
    assert.deepEqual(files(spec), ['e2e/cart.spec.ts']);   // spec-self 만 — src 변경 0 이라 unmapped/alwaysRun 없음
    const docs = await computeSelection({ config, changedFiles: ['README.md'], ctx });
    assert.equal(docs.apps.web.mode, 'partial'); assert.deepEqual(files(docs), []);
  } finally { cleanup(); }
});

test('writeSelection emits test-list lines per project and amend add/remove is recorded', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    const sel = await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx: await realCtx(config, ts) });
    const { testLists } = writeSelection(config, sel);
    const lines = readFileSync(testLists.web, 'utf8').trim().split('\n');
    assert.ok(lines.includes('[chromium] › e2e/cart.spec.ts') && lines.includes('[mobile-chrome] › e2e/cart.spec.ts'));
    assert.ok(existsSync(path.join(root, '.e2e-rail/selections', `${sel.id}.json`)));
    const amended = amendSelection(config, { app: 'web', add: [{ spec: 'e2e/order-detail.spec.ts', reason: 'opener shares detail args' }], remove: [], allowRemove: false });
    assert.ok(amended.apps.web.specs.some((s) => s.file === 'e2e/order-detail.spec.ts' && s.reasons[0] === 'added: opener shares detail args'));
    assert.throws(() => amendSelection(config, { app: 'web', add: [], remove: [{ spec: 'e2e/smoke.spec.ts', reason: 'x' }], allowRemove: false }), /promote/);
  } finally { cleanup(); }
});

async function realCtx(config, ts) {
  const { loadOrBuildSpecIndex } = await import('../src/spec-index.mjs');
  const { loadOrBuildGraph, findMain } = await import('../src/graph.mjs');
  const { getAdapter } = await import('../src/adapters/index.mjs');
  return { forApp: async (app) => {
    const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts });
    return { index: await loadOrBuildSpecIndex({ config, app, ts }), graph: await loadOrBuildGraph({ config, app, ts }), entries, unresolvedEntries: unresolved, main: findMain(config, app) };
  } };
}
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/select.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// src/select.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir, findApp } from './config.mjs';
import { matchAny, matchGlob } from './util/glob.mjs';
import { gitChangedFiles, gitUncommittedFiles, gitHead, gitDiffHash, gitUntrackedHash } from './util/git.mjs';
import { sha256 } from './util/hash.mjs';
import { routeMatches, slugOf, loadOrBuildSpecIndex } from './spec-index.mjs';
import { loadOrBuildGraph, affectedEntries, apiLiterals, findMain } from './graph.mjs';
import { getAdapter } from './adapters/index.mjs';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
export const newId = (prefix) => `${prefix}-${stamp()}-${Math.random().toString(16).slice(2, 6)}`;
const toPosix = (p) => p.split(path.sep).join('/');

export function classifyFile(config, repoRel) {
  if (matchAny(config.ignore, repoRel)) return { kind: 'ignore', reason: 'ignore' };
  if (matchAny(config.shared, repoRel)) return { kind: 'shared', reason: `shared:${repoRel}` };
  const app = config.apps.find((a) => a.root === '.' || repoRel === a.root || repoRel.startsWith(`${a.root}/`));
  if (!app) return { kind: 'unknown-root', reason: `unknown-root:${repoRel}` };
  const appRel = app.root === '.' ? repoRel : repoRel.slice(app.root.length + 1);
  if (matchAny(app.tiers.ignore, appRel)) return { kind: 'ignore', app, appRel, reason: 'ignore' };
  const full = app.tiers.full.find((g) => matchGlob(g, appRel));
  if (full) return { kind: 'tier-full', app, appRel, reason: `tier-full:${full}` };
  if (appRel.startsWith(`${app.specDir}/`) && /\.spec\.[cm]?[tj]sx?$/.test(appRel)) return { kind: 'spec', app, appRel, reason: `spec-self:${appRel}` };
  if (app.supportDirs.some((d) => appRel.startsWith(`${d}/`))) return { kind: 'support', app, appRel, reason: `support:${appRel}` };
  if (appRel.startsWith(`${app.srcDir}/`)) return { kind: 'src', app, appRel, reason: `src:${appRel}` };
  return { kind: 'app-other', app, appRel, reason: `app-other:${appRel}` };
}

export async function computeSelection({ config, changedFiles, base = null, head = 'HEAD', includeUncommitted = true, ctx }) {
  const sel = { id: newId('sel'), createdAt: new Date().toISOString(), base, head, includeUncommitted, changedFiles, codeId: codeIdOf(config.root), apps: {} };
  const per = Object.fromEntries(config.apps.map((a) => [a.name, { mode: 'partial', reasons: [], specs: new Map(), added: [], removed: [], unmappedIncluded: 0, changedFiles: [], srcChanged: [], specChanged: [], supportChanged: [] }]));
  const widen = (name, reason) => { per[name].mode = 'full'; per[name].reasons.push(reason); };
  if (changedFiles === null) for (const a of config.apps) widen(a.name, 'no-base');
  for (const file of changedFiles ?? []) {
    const c = classifyFile(config, toPosix(file));
    if (c.kind === 'ignore') continue;
    if (c.kind === 'shared' || c.kind === 'unknown-root') { for (const a of config.apps) widen(a.name, c.reason); continue; }
    per[c.app.name].changedFiles.push(c.appRel);
    if (c.kind === 'tier-full' || c.kind === 'app-other') widen(c.app.name, c.reason);
    else if (c.kind === 'spec') per[c.app.name].specChanged.push(c.appRel);
    else if (c.kind === 'support') per[c.app.name].supportChanged.push(c.appRel);
    else per[c.app.name].srcChanged.push(c.appRel);
  }
  for (const app of config.apps) {
    const p = per[app.name];
    const addSpec = (file, projects, reason) => { const cur = p.specs.get(file) ?? { file, projects, reasons: [] }; if (!cur.reasons.includes(reason)) cur.reasons.push(reason); p.specs.set(file, cur); };
    if (p.mode === 'full') { sel.apps[app.name] = finish(p); continue; }
    const needsIndex = p.srcChanged.length || p.specChanged.length || p.supportChanged.length;
    if (!needsIndex) { sel.apps[app.name] = finish(p); continue; }
    const { index, graph, entries, unresolvedEntries, main } = await ctx.forApp(app);
    for (const s of p.specChanged) if (index.specs[s]) addSpec(s, index.specs[s].projects, `spec-self:${s}`);
    for (const sup of p.supportChanged) for (const [file, info] of Object.entries(index.specs)) if (info.supports.includes(sup)) addSpec(file, info.projects, `support:${sup}`);
    if (p.srcChanged.length) {
      if (unresolvedEntries.length) widen(app.name, `adapter-unresolved:${unresolvedEntries[0]}`);
      const { entries: hit, unresolved, mainOnly } = affectedEntries(graph, p.srcChanged, entries.map((e) => e.file), main);
      for (const u of unresolved) widen(app.name, `graph-unresolved:${u}`);
      for (const m of mainOnly) widen(app.name, `graph-main-only:${m}`);
      if (p.mode === 'partial') {
        const dirAbs = appDir(config, app);
        const routes = entries.filter((e) => hit.has(e.file));
        const literals = p.srcChanged.flatMap((f) => (existsSync(path.join(dirAbs, f)) ? apiLiterals(path.join(dirAbs, f), app.apiPrefix) : []));
        for (const [file, info] of Object.entries(index.specs)) {
          for (const r of routes) for (const sr of info.routes) if (routeMatches(r.route, sr)) addSpec(file, info.projects, `route:${r.route} ← ${r.file}`);
          for (const g of info.apis) for (const lit of literals) if (matchGlob(g, lit)) addSpec(file, info.projects, `api:${g} ← ${lit}`);
          for (const imp of info.imports) if (p.srcChanged.includes(imp)) addSpec(file, info.projects, `import:${imp}`);
          if (info.unmapped) { addSpec(file, info.projects, 'unmapped'); }
          if (app.alwaysRun.includes(slugOf(file))) addSpec(file, info.projects, 'always-run');
        }
        p.unmappedIncluded = [...p.specs.values()].filter((s) => s.reasons.includes('unmapped')).length;
      }
    }
    sel.apps[app.name] = finish(p);
  }
  return sel;
  function finish(p) { return { mode: p.mode, reasons: [...new Set(p.reasons)], specs: p.mode === 'full' ? [] : [...p.specs.values()].sort((a, b) => a.file.localeCompare(b.file)), added: p.added, removed: p.removed, unmappedIncluded: p.unmappedIncluded, changedFiles: p.changedFiles }; }
}

export function codeIdOf(root) { return sha256(`${gitHead(root)}\n${gitDiffHash(root)}\n${gitUntrackedHash(root)}`); }

export async function select({ config, ts, base, head = 'HEAD', includeUncommitted = !process.env.CI }) {
  let changed = gitChangedFiles(config.root, base, head);
  if (changed !== null && includeUncommitted) changed = [...new Set([...changed, ...gitUncommittedFiles(config.root)])].sort();
  const ctx = { forApp: async (app) => { const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts }); return { index: await loadOrBuildSpecIndex({ config, app, ts }), graph: await loadOrBuildGraph({ config, app, ts }), entries, unresolvedEntries: unresolved, main: findMain(config, app) }; } };
  return computeSelection({ config, changedFiles: changed, base, head, includeUncommitted, ctx });
}

export function testListLines(appSel) { return appSel.specs.flatMap((s) => s.projects.map((p) => `[${p}] › ${s.file}`)); }
export function writeSelection(config, selection) {
  const dir = ledgerDir(config); mkdirSync(path.join(dir, 'selections'), { recursive: true });
  const selectionAbs = path.join(dir, 'selection.json');
  writeFileSync(selectionAbs, JSON.stringify(selection, null, 2));
  writeFileSync(path.join(dir, 'selections', `${selection.id}.json`), JSON.stringify(selection, null, 2));
  const testLists = {};
  for (const [name, a] of Object.entries(selection.apps)) {
    const abs = path.join(dir, `test-list.${name}.txt`);
    if (a.mode === 'full') { testLists[name] = null; continue; }
    writeFileSync(abs, `${testListLines(a).join('\n')}\n`); testLists[name] = abs;
  }
  return { selectionAbs, testLists };
}
export function readSelection(config, id) {
  const abs = id ? path.join(ledgerDir(config), 'selections', `${id}.json`) : path.join(ledgerDir(config), 'selection.json');
  if (!existsSync(abs)) throw new Error(`selection not found: ${abs}. Run \`e2e-rail select\` first.`);
  return JSON.parse(readFileSync(abs, 'utf8'));
}
export function amendSelection(config, { app, add = [], remove = [], allowRemove = false }) {
  const sel = readSelection(config); const a = sel.apps[findApp(config, app).name];
  for (const { spec, reason } of add) { if (!a.specs.some((s) => s.file === spec)) a.specs.push({ file: spec, projects: ['chromium'], reasons: [] }); const s = a.specs.find((x) => x.file === spec); s.reasons.unshift(`added: ${reason}`); a.added.push({ spec, reason }); }
  if (remove.length && !allowRemove) throw new Error('removing specs from a selection is only allowed after `shadow promote` (trust=selected)');
  for (const { spec, reason } of remove) { a.specs = a.specs.filter((s) => s.file !== spec); a.removed.push({ spec, reason }); }
  a.specs.sort((x, y) => x.file.localeCompare(y.file));
  writeSelection(config, sel);
  return sel;
}
export const selectionExitCode = (sel) => (Object.values(sel.apps).some((a) => a.mode === 'full') ? 10 : 0);
```

`amendSelection` 의 `add` 는 프로젝트 목록을 인덱스에서 읽어야 정확하다. 캐시된 `map.<app>.json` 이 있으면 거기서 `projects` 를 가져오고 없으면 `['chromium']` 으로 둔 뒤 경고를 출력한다(코드에 `existsSync(map)` 분기 추가).

- [ ] **Step 4: 통과 확인**

Run: `node --test test/select.test.mjs`
Expected: PASS 6

- [ ] **Step 5: 커밋**

```bash
git add -- <이 태스크 Files 블록의 경로 전부> && git commit -m "feat(select): change classification table, graph/api/import matching, test-list output and amendments"
```

---

**1부 끝.** 2부(`…-implementation-part2.md`)로 이어진다: Task 10 지문 · 11 원장 · 12 run+lock · 13 verify+shadow · 14 measure+shard · 15 CLI 배선과 init/map · 16 플러그인 층(스킬·에이전트·훅·Codex 패키지·템플릿·README) · 17 계약 테스트·릴리스·guardrail 등재.
