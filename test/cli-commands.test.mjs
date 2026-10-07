import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../src/config.mjs';
import { testListLines } from '../src/select.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { makeTempRepo } from './helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'e2e-rail.mjs');

// The binary as skills and CI call it, with CI removed from the environment (select and run defaults follow CI).
// `out` is stdout + stderr; assertions about which stream a line goes to use `stdout` / `stderr`.
function cli(cwd, args, env = {}) {
  const { CI: _ci, ...base } = process.env;
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

// A temp copy of the fixture with its own private lock dir (E2E_RAIL_LOCK_DIR): no test touches the machine lock.
function withRepo(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-cli-lock-'));
  const run = (args, env = {}) => cli(root, args, { E2E_RAIL_LOCK_DIR: lockRoot, ...env });
  try {
    return fn({ root, run, lockRoot, at: (rel) => path.join(root, rel) });
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
    cleanup();
  }
}

function withEmptyDir(fn) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-cli-empty-')));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const commit = (root, files) => {
  execCapture('git', ['add', '--', ...files], { cwd: root });
  execCapture('git', ['commit', '-qm', 'change'], { cwd: root });
};
const ledgerLines = (root) => {
  const abs = path.join(root, '.e2e-rail/ledger.jsonl');
  return existsSync(abs) ? readFileSync(abs, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const TABLE_EDIT = 'export const Table = (rows: unknown[]) => rows.length + 1;\n';
const RUN_ID = /run-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}/;

test('dispatch: no args → usage on stderr (2); --help/-h → stdout (0); -v; prototype keys are unknown commands', () => {
  withEmptyDir((dir) => {
    const none = cli(dir, []);
    assert.equal(none.code, 2);
    assert.equal(none.stdout, '');
    assert.match(none.stderr, /usage: e2e-rail <command>/);
    for (const flag of ['--help', '-h']) {
      const r = cli(dir, [flag]);
      assert.equal(r.code, 0, flag);
      assert.equal(r.stderr, '');
      assert.match(r.stdout, /usage: e2e-rail <command>/);
      for (const name of ['init', 'map', 'select', 'run', 'verify', 'shadow', 'measure', 'shard', 'lock']) assert.match(r.stdout, new RegExp(`^ {2}${name} `, 'm'));
    }
    const v = cli(dir, ['-v']);
    assert.equal(v.code, 0);
    assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = cli(dir, [name]);
      assert.equal(r.code, 2, name);
      assert.match(r.stderr, new RegExp(`unknown command: ${name}`));
    }
    const help = cli(dir, ['run', '--help']);
    assert.equal(help.code, 0, help.out);
    assert.match(help.stdout, /^usage: e2e-rail run .*--selection \[id\]/);
  });
});

test('errors: one `e2e-rail: <message>` line on stderr with exit 1, never a stack; usage errors exit 2', () => {
  assert.equal(new ConfigError('x').name, 'ConfigError');
  withEmptyDir((dir) => {
    const r = cli(dir, ['map']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /^e2e-rail: e2e-rail\.config\.mjs not found in .*Run `e2e-rail init` first\.\n$/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
  withRepo(({ root, run }) => {
    const p = run(['run', '--full', '--no-lock', '--', '--reporter=html']);
    assert.equal(p.code, 1, p.out);
    assert.match(p.stderr, /^e2e-rail: --reporter cannot be passed through to Playwright/);
    assert.doesNotMatch(p.stderr, /e2e-rail: e2e-rail:/);
    assert.doesNotMatch(p.stderr, /\n\s+at /);
    assert.deepEqual(ledgerLines(root), []);

    const unknownApp = run(['verify', '--app', 'nope']);
    assert.equal(unknownApp.code, 1);
    assert.match(unknownApp.stderr, /^e2e-rail: unknown app nope\n$/);

    for (const args of [
      ['run'], ['run', '--full', '--selection'], ['run', '--full', '--shard', '3/2'], ['run', '--full', '--workers', 'x'],
      ['run', '--full', 'e2e/orders.spec.ts'], ['run', '--full', '--mode', 'staging'], ['run', '--test-list'],
      ['select', '--bogus'], ['select', '--add', 'e2e/cart.spec.ts'], ['select', '--reason', 'x'], ['select', '--', 'x'],
      ['verify', '--require', 'all'], ['verify', '--max-age', 'soon'], ['map', '--app'], ['init', 'extra'],
      ['shadow'], ['shadow', 'record'], ['shadow', 'status', '--run', 'x'], ['measure', 'fastest'], ['measure', 'workers', '1,x', '--test-list', 'l.txt'],
      ['shard', 'plan'], ['shard', 'merge'], ['lock'], ['lock', 'run', 'medium', '--', 'true'], ['lock', 'run', 'light'],
    ]) {
      const u = run(args);
      assert.equal(u.code, 2, `${args.join(' ')} → ${u.out}`);
      assert.match(u.stderr, /^e2e-rail: .+\nusage: e2e-rail \w+ /, args.join(' '));
    }
  });
});

test('init detects the playwright config, writes config and gitignore; map --check reports unmapped; --explain', () => withRepo(({ run, at }) => {
  rmSync(at('e2e-rail.config.mjs'));
  const r = run(['init']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(at('e2e-rail.config.mjs')));
  const cfg = readFileSync(at('e2e-rail.config.mjs'), 'utf8');
  assert.match(cfg, /name: 'sample-app'/);
  assert.match(cfg, /root: '\.'/);
  assert.match(cfg, /playwrightConfig: 'playwright\.config\.ts'/);
  assert.match(readFileSync(at('.gitignore'), 'utf8'), /\.e2e-rail\//);
  assert.match(r.stdout, /e2e:select/);
  assert.match(r.stdout, /^ {2}"e2e:verify": "e2e-rail verify --require full"$/m, 'the template declares no preview build');
  assert.match(r.stdout, /next: e2e-rail map --check/);
  // The template's .tsx route-table globs match nothing here; left in, each would be an adapter `unresolved` (full).
  assert.match(cfg, /routeFiles: \['src\/\*\*\/routes\.ts', 'src\/router\.ts'\]/);
  assert.match(r.stdout, /adapter\.routeFiles: src\/\*\*\/routes\.ts, src\/router\.ts \(template globs that match no file were left out\)/);

  const m = run(['map', '--check']);
  assert.equal(m.code, 0, m.out);
  assert.match(m.stdout, /^app sample-app: 4 specs indexed · \d+ route entries · adapter unresolved \d+$/m);
  assert.doesNotMatch(m.stdout, /matched no file/);
  assert.match(m.stdout, /graph: \d+ files · missing 0 · opaque 0 · main src\/main\.ts/);
  // The fixture nests its routes under '/app' and the generic template has basePath '': the verdict says why.
  assert.match(m.stdout, /verdict: every src change will run full: the react-router-lazy adapter could not read 2 route definition/);
  assert.match(m.stdout, /unmapped/);
  assert.match(m.stdout, /smoke\.spec\.ts/);
  assert.match(m.stdout, /^covered apps: sample-app$/m);

  const e = run(['map', '--explain', 'e2e/cart.spec.ts']);
  assert.equal(e.code, 0, e.out);
  assert.match(e.stdout, /routes.*cart/s);
  assert.equal(JSON.parse(e.stdout).spec, 'e2e/cart.spec.ts');
  const unknown = run(['map', '--explain', 'e2e/nope.spec.ts']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^e2e-rail: e2e\/nope\.spec\.ts is not in the spec index of app sample-app/);
}));

test('init never overwrites a config without --force; ignores the ledger and Playwright output once, by git check-ignore', () => withRepo(({ run, at }) => {
  const before = readFileSync(at('e2e-rail.config.mjs'), 'utf8');
  // `/.e2e-rail` and `**/test-results` already ignore two of the four (no line equals the pattern we would write).
  writeFileSync(at('.gitignore'), 'argv.json\n/.e2e-rail\n**/test-results');
  const r = run(['init']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /e2e-rail\.config\.mjs exists; left unchanged \(use --force to overwrite\)/);
  assert.equal(readFileSync(at('e2e-rail.config.mjs'), 'utf8'), before);
  // I3: the fixture's app declares run.preview, so the suggested run and verify both use preview mode
  assert.match(r.stdout, /^suggested package\.json scripts \(the app declares run\.preview: run and verify in the same mode\):$/m);
  assert.match(r.stdout, /^ {2}"e2e:run": {4}"e2e-rail run --selection --mode preview"$/m);
  assert.match(r.stdout, /^ {2}"e2e:verify": "e2e-rail verify --require full --mode preview"$/m);
  const gi = readFileSync(at('.gitignore'), 'utf8');
  assert.match(gi, /^\*\*\/test-results\n/m); // the missing final newline was added before the new block
  for (const p of ['playwright-report/', 'blob-report/']) assert.equal(gi.split('\n').filter((l) => l === p).length, 1, p);
  for (const p of ['.e2e-rail/', 'test-results/']) assert.ok(!gi.split('\n').includes(p), p);
  assert.match(r.stdout, /added to \.gitignore: playwright-report\/, blob-report\//);

  const again = run(['init']);
  assert.equal(again.code, 0, again.out);
  assert.equal(readFileSync(at('.gitignore'), 'utf8'), gi);
  assert.doesNotMatch(again.stdout, /added to \.gitignore/);

  const forced = run(['init', '--force']);
  assert.equal(forced.code, 0, forced.out);
  assert.match(forced.stdout, /wrote e2e-rail\.config\.mjs/);
  assert.notEqual(readFileSync(at('e2e-rail.config.mjs'), 'utf8'), before);
}));

test('init picks the referenced tsconfig that holds compilerOptions.paths when tsconfig.json is solution-style', () => withRepo(({ run, at }) => {
  writeFileSync(at('tsconfig.app.json'), readFileSync(at('tsconfig.json'), 'utf8'));
  writeFileSync(at('tsconfig.node.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', noEmit: true }, include: ['build.mjs'] }));
  writeFileSync(at('tsconfig.json'), '// solution-style, as Vite writes it\n{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }] }\n');
  rmSync(at('e2e-rail.config.mjs'));
  const r = run(['init']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /tsconfig\.json is solution-style.*using tsconfig\.app\.json/);
  assert.match(readFileSync(at('e2e-rail.config.mjs'), 'utf8'), /tsconfig: 'tsconfig\.app\.json'/);
  const m = run(['map', '--check']);
  assert.equal(m.code, 0, m.out);
  assert.match(m.stdout, /verdict: /);
}));

test('map --check: one verdict per app — narrowing possible, or why every src change runs full', () => withRepo(({ run, at }) => {
  const ok = run(['map', '--check']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.stdout, /^ {2}verdict: narrowing possible/m);
  assert.match(ok.stdout, /^covered apps: web$/m);
  const only = run(['map', '--check', '--app', 'web']);
  assert.equal(only.code, 0, only.out);
  assert.doesNotMatch(only.stdout, /covered apps/);

  // A manual adapter without routeFiles: a page climbs past the route table to main.
  const cfg = readFileSync(at('e2e-rail.config.mjs'), 'utf8');
  const manual = cfg.replace(/adapter: \{[^}]*\},/, "adapter: { name: 'manual', map: { '/app/cart': ['src/features/cart/CartPage.ts'] }, basePath: '/app' },");
  assert.notEqual(manual, cfg);
  writeFileSync(at('e2e-rail.config.mjs'), manual);
  const coupled = run(['map', '--check']);
  assert.equal(coupled.code, 0, coupled.out);
  assert.match(coupled.stdout, /verdict: every src change will run full: every route entry file reaches src\/main\.ts.*adapter\.routeFiles is empty/);

  // A broken internal import: no edge can be trusted.
  writeFileSync(at('src/lib/broken.ts'), "import { x } from './nope';\nexport const y = x;\n");
  const broken = run(['map', '--check']);
  assert.equal(broken.code, 0, broken.out);
  assert.match(broken.stdout, /graph: \d+ files · missing 1 · opaque 0/);
  assert.match(broken.stdout, /missing: src\/lib\/broken\.ts → \.\/nope/);
  assert.match(broken.stdout, /verdict: every src change will run full: 1 internal import/);
  assert.doesNotMatch(broken.stdout, /outside specDir/);

  // M10: a test file Playwright lists outside specDir is indexed unmapped and never read: map --check says so
  mkdirSync(at('other'));
  writeFileSync(at('other/outside.spec.ts'), "import { test } from '@playwright/test';\ntest('x', async () => {});\n");
  const list = JSON.parse(readFileSync(at('stub/list.json'), 'utf8'));
  list.suites.push({ title: 'outside.spec.ts', file: '../other/outside.spec.ts', suites: [],
    specs: [{ title: 'x', file: '../other/outside.spec.ts', tests: [{ projectName: 'chromium', status: 'skipped', results: [] }] }] });
  writeFileSync(at('stub/list.json'), JSON.stringify(list));
  writeFileSync(at('playwright.config.ts'), '// a second testDir\n', { flag: 'a' }); // what makes Playwright list it (and rebuilds the index)
  const outside = run(['map', '--check']);
  assert.equal(outside.code, 0, outside.out);
  assert.match(outside.stdout, /^ {2}warning: 1 tests outside specDir — set specDir to Playwright rootDir `e2e`$/m);
  assert.match(outside.stdout, /^ {4}outside: other\/outside\.spec\.ts$/m);
}));

test('select → run --selection → verify round trip with exit codes', () => withRepo(({ root, run, at }) => {
  const full = run(['select', '--base', 'nope']);
  assert.equal(full.code, 10, full.out);
  assert.match(full.stdout, /web\s+full/);
  const bare = run(['select', '--base']); // `--base $(cat <missing last-green>)`: no base is a full selection (spec §6)
  assert.equal(bare.code, 10, bare.out);
  assert.match(bare.stdout, /no-base/);

  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const s = run(['select', '--base', 'HEAD']);
  assert.equal(s.code, 0, s.out);
  assert.match(s.stdout, /partial/);
  assert.match(s.stdout, /apps: web$/m);
  assert.match(s.stdout, /^test-list web: \.e2e-rail\/test-list\.web\.txt$/m);
  assert.ok(existsSync(at('.e2e-rail/test-list.web.txt')));

  const v0 = run(['verify']);
  assert.equal(v0.code, 20, v0.out);
  assert.equal(v0.stdout, 'stale: nothing verified yet (no passing full run or shard set of app web in dev mode)\n');

  const r = run(['run', '--selection', '--workers', '1', '--no-lock']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^run-id run-\S+ · kind selected · rc 0 · \d+ms · failures 0$/m);
  assert.match(r.stdout, /^shadowed: a selected run does not replace a full run while trust=shadow$/m);
  assert.equal(ledgerLines(root).at(-1).shadowed, true);
  const v1 = run(['verify']);
  assert.equal(v1.code, 21, v1.out);
  assert.match(v1.stdout, /^insufficient: /);
  // I4: the selected line names the selection the run came from and whether it ran while trust=shadow
  const vs = run(['verify', '--require', 'selected']);
  assert.equal(vs.code, 0, vs.out);
  const selId = JSON.parse(readFileSync(at('.e2e-rail/selection.json'), 'utf8')).id;
  assert.equal(vs.stdout, `verified: selected@${r.stdout.match(RUN_ID)[0]} (selection ${selId}, shadowed) (just now)\n`);
  const vj = JSON.parse(run(['verify', '--require', 'selected', '--json']).stdout);
  assert.deepEqual([vj.kind, vj.selectionId, vj.shadowed], ['selected', selId, true]);

  const f = run(['run', '--full', '--no-lock']);
  assert.equal(f.code, 0, f.out);
  assert.match(f.stdout, /kind full/);
  assert.doesNotMatch(f.stdout, /shadowed/);
  const v2 = run(['verify']);
  assert.equal(v2.code, 0, v2.out);
  assert.match(v2.stdout, /^verified: full@run-/);
  assert.equal(v2.stdout.trim().split('\n').length, 1);
  const json = run(['verify', '--json']);
  assert.equal(json.code, 0);
  const j = JSON.parse(json.stdout);
  assert.equal(j.status, 'verified');
  assert.equal(j.runId, f.stdout.match(RUN_ID)[0]);
  const old = run(['verify', '--max-age', '0']);
  assert.equal(old.code, 20, old.out);
  assert.match(old.stdout, /older than --max-age 0/);

  const runId = f.stdout.match(RUN_ID)[0];
  const sh = run(['shadow', 'record', '--run', runId]);
  assert.equal(sh.code, 0, sh.out);
  assert.match(sh.stdout, /hit · streak 1\/2/);
  const st = run(['shadow', 'status']);
  assert.match(st.stdout, /streak/);
  assert.match(st.stdout, /^trust shadow · streak 1\/2 · promotable no$/m);
  assert.match(st.stdout, new RegExp(`${runId} hit`));

  writeFileSync(at('src/components/Table.ts'), 'export const Table = (rows: unknown[]) => rows.length + 2;\n');
  const v3 = run(['verify']);
  assert.equal(v3.code, 20, v3.out);
  // B: the full pass above had the Table edit uncommitted, so it vouches for that code only, never for a commit
  assert.equal(v3.stdout, 'stale: no passing run for this code · differing: diff · no full pass of a committed tree yet, so no base to narrow from\n');

  commit(root, ['src/components/Table.ts']);
  assert.equal(run(['run', '--full', '--no-lock']).code, 0);
  const head = execCapture('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const v4 = run(['verify']);
  assert.equal(v4.code, 20, v4.out);
  assert.equal(v4.stdout, `stale: no passing run for this code · differing: diff · last verified head ${head} · narrow with \`e2e-rail select --base ${head}\`\n`);
}));

test('a filtered full run says so: --project and --grep print kind full (filtered) and a filtered: line; a plain full run neither', () => withRepo(({ root, run }) => {
  const plain = run(['run', '--full', '--no-lock']);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.stdout, /^run-id run-\S+ · kind full · rc 0 · \d+ms · failures 0$/m);
  assert.doesNotMatch(plain.stdout, /\(filtered\)/);
  assert.doesNotMatch(plain.stdout, /^filtered:/m);
  assert.equal(ledgerLines(root).at(-1).filtered, false);
  // A: whatever narrows or relaxes the run is named, e2e-rail's own --project included
  const cases = [
    [['--project', 'chromium'], '--project'], [['--', '--grep', 'cart'], '--grep'], [['--', '-Gcart'], '-G'],
    [['--', '--ignore-snapshots'], '--ignore-snapshots'], [['--project', 'chromium', '--', '--retries', '2', 'e2e/cart.spec.ts'], '--project --retries e2e/cart.spec.ts'],
  ];
  for (const [args, names] of cases) {
    const r = run(['run', '--full', '--no-lock', ...args]);
    assert.equal(r.code, 0, `${args.join(' ')} → ${r.out}`);
    assert.match(r.stdout, /^run-id run-\S+ · kind full \(filtered\) · rc 0 · \d+ms · failures 0$/m, args.join(' '));
    assert.ok(r.stdout.split('\n').includes(`filtered: ${names} narrow or relax the run; not a verification`), `${args.join(' ')} → ${r.stdout}`);
    assert.equal(ledgerLines(root).at(-1).filtered, true);
    assert.equal(run(['verify']).code, 0, 'the plain full run still verifies this code; the filtered ones changed nothing');
  }
  // neutral options leave a full run a full run
  const neutral = run(['run', '--full', '--no-lock', '--', '--headed', '-x', '--trace', 'on', '-j2']);
  assert.equal(neutral.code, 0, neutral.out);
  assert.match(neutral.stdout, /^run-id run-\S+ · kind full · rc 0 /m);
  assert.doesNotMatch(neutral.stdout, /^filtered:/m);
  // refused before anything runs
  const ui = run(['run', '--full', '--no-lock', '--', '--ui']);
  assert.equal(ui.code, 1, ui.out);
  assert.match(ui.stderr, /^e2e-rail: --ui cannot be passed through to Playwright/m);
}));

test('run --test-list that matches nothing is a failure (R56): rc 1, a failed: line without a test, the rootDir hint', () => withRepo(({ root, run, at }) => {
  writeFileSync(at('stub/report-empty.json'), JSON.stringify({ config: { rootDir: '<ABS_APP_DIR>/e2e' }, suites: [] }));
  writeFileSync(at('wrong.txt'), '[chromium] › e2e/orders.spec.ts\n');
  const r = run(['run', '--test-list', 'wrong.txt', '--no-lock'], { STUB_PW_REPORT: at('stub/report-empty.json') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.stdout, /^run-id run-\S+ · kind selected · rc 1 · \d+ms · failures 1$/m);
  assert.match(r.stdout, /^ {2}failed: test list matched no tests$/m);
  assert.match(r.stderr, /^e2e-rail: test list matched no tests — check paths are relative to Playwright rootDir$/m);
  assert.equal(ledgerLines(root).at(-1).rc, 1);
  writeFileSync(at('lost.txt'), '[chromium] › orders.spec.ts\n[chromium] › renamed.spec.ts\n');
  const lost = run(['run', '--test-list', 'lost.txt', '--no-lock']);
  assert.equal(lost.code, 1, lost.out);
  assert.match(lost.stdout, /^ {2}failed: test list line matched no tests: \[chromium\] › renamed\.spec\.ts$/m);
  // I4: a passing ad-hoc test list is no selection's run: `verify --require selected` does not take it
  writeFileSync(at('ok.txt'), '[chromium] › orders.spec.ts\n');
  assert.equal(run(['run', '--test-list', 'ok.txt', '--no-lock']).code, 0);
  const v = run(['verify', '--require', 'selected']);
  assert.equal(v.code, 21, v.out);
  assert.equal(v.stdout, 'insufficient: this code has only selected run(s); --require selected needs a full run, a complete shard set or a selected run from `run --selection`\n');
}));

test('run --selection: test list rebuilt from the selection it reads ([id]); full selection runs full; 0 specs skips', () => withRepo(({ root, run, at }) => {
  const argvFile = at('argv.json');
  assert.equal(run(['select', '--base', 'HEAD']).code, 0); // nothing changed: partial with no spec
  const skip = run(['run', '--selection', '--no-lock'], { STUB_PW_ARGV_FILE: argvFile });
  assert.equal(skip.code, 0, skip.out);
  assert.equal(skip.stdout, 'web: nothing selected (partial, 0 specs)\n');
  assert.ok(!existsSync(argvFile), 'Playwright was not started');
  assert.deepEqual(ledgerLines(root), []);
  // I5: what counts is the test-list lines; a spec without a Playwright project writes none
  const selAbs = at('.e2e-rail/selection.json');
  const hand = JSON.parse(readFileSync(selAbs, 'utf8'));
  Object.assign(hand.apps.web, { rootDir: 'e2e', specs: [{ file: 'e2e/orders.spec.ts', projects: [], reasons: ['hand-made'] }] });
  writeFileSync(selAbs, JSON.stringify(hand));
  const noLines = run(['run', '--selection', '--no-lock'], { STUB_PW_ARGV_FILE: argvFile });
  assert.equal(noLines.code, 0, noLines.out);
  assert.equal(noLines.stdout, 'web: nothing selected (partial, 1 spec(s), 0 test-list lines)\n');
  assert.ok(!existsSync(argvFile), 'Playwright was not started');
  assert.deepEqual(ledgerLines(root), []);

  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const sel1 = JSON.parse(run(['select', '--base', 'HEAD', '--json']).stdout);
  const lines1 = testListLines(sel1.apps.web);
  assert.ok(lines1.length > 0);
  assert.equal(run(['select', '--base', 'HEAD', '--no-uncommitted']).code, 0); // replaces selection.json and the list
  assert.equal(readFileSync(at('.e2e-rail/test-list.web.txt'), 'utf8'), '');

  const r = run(['run', '--selection', sel1.id, '--no-lock'], { STUB_PW_ARGV_FILE: argvFile });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(at('.e2e-rail/test-list.web.txt'), 'utf8'), `${lines1.join('\n')}\n`);
  const argv = JSON.parse(readFileSync(argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('--test-list') + 1], at('.e2e-rail/test-list.web.txt'));
  const e1 = ledgerLines(root).at(-1);
  assert.equal(e1.kind, 'selected');
  assert.equal(e1.selectionId, sel1.id);

  const full = run(['select', '--base', 'nope']);
  assert.equal(full.code, 10);
  const fullId = full.stdout.match(/sel-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}/)[0];
  const rf = run(['run', '--selection', '--no-lock']);
  assert.equal(rf.code, 0, rf.out);
  assert.match(rf.stdout, new RegExp(`^web: selection ${fullId} runs this app in full \\(no-base\\); running the full suite$`, 'm'));
  assert.match(rf.stdout, /kind full/);
  const e2 = ledgerLines(root).at(-1);
  assert.equal(e2.kind, 'full');
  assert.equal(e2.selectionId, fullId);
  assert.doesNotMatch(rf.stderr, /warning/);

  writeFileSync(at('src/features/cart/services/cart.ts'), 'export const addToCart = () => 2;\n'); // edited after select
  const late = run(['run', '--selection', '--no-lock']);
  assert.equal(late.code, 0, late.out);
  assert.match(late.stderr, new RegExp(`^e2e-rail: warning: selection ${fullId} was computed for other code`, 'm'));
}));

test('select --app writes only that app and drops other test lists; --app is required where several apps are configured', () => withRepo(({ root, run, at }) => {
  writeFileSync(at('e2e-rail.config.mjs'), `export default {
  apps: ['web', 'admin'].map((name) => ({
    name, root: '.', playwrightConfig: 'playwright.config.ts',
    adapter: { name: 'react-router-lazy', routeFiles: ['src/features/*/routes.ts', 'src/router.ts'], basePath: '/app' },
    tiers: { full: ['src/main.ts', 'src/router.ts', 'src/shell/**'] },
  })),
  shadow: { promoteAfter: 2 },
};
`);
  commit(root, ['e2e-rail.config.mjs']);
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const all = run(['select', '--base', 'HEAD']);
  assert.equal(all.code, 0, all.out);
  assert.match(all.stdout, /apps: web, admin$/m);
  assert.ok(existsSync(at('.e2e-rail/test-list.admin.txt')));

  const one = run(['select', '--base', 'HEAD', '--app', 'web']);
  assert.equal(one.code, 0, one.out);
  assert.match(one.stdout, /apps: web$/m);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(at('.e2e-rail/selection.json'), 'utf8')).apps), ['web']);
  assert.ok(existsSync(at('.e2e-rail/test-list.web.txt')));
  assert.ok(!existsSync(at('.e2e-rail/test-list.admin.txt')), 'a list of an app absent from the selection is removed');

  const noApp = run(['run', '--selection', '--no-lock']);
  assert.equal(noApp.code, 1);
  assert.match(noApp.stderr, /^e2e-rail: several apps configured \(web, admin\); pass --app <name>\n$/);
  const other = run(['run', '--selection', '--app', 'admin', '--no-lock']);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /has no entry for app admin/);
  assert.match(run(['map', '--check']).stdout, /^covered apps: web, admin$/m);
}));

test('select --add/--remove amend the current selection with a reason; removing only after shadow promote', () => withRepo(({ run, at }) => {
  assert.equal(run(['map']).code, 0);
  assert.equal(run(['select', '--base', 'HEAD']).code, 0);
  const add = run(['select', '--add', 'e2e/cart.spec.ts', '--reason', 'the cart badge reads the changed store']);
  assert.equal(add.code, 0, add.out);
  assert.match(add.stdout, /^added web: e2e\/cart\.spec\.ts \(the cart badge reads the changed store\)$/m);
  assert.equal(readFileSync(at('.e2e-rail/test-list.web.txt'), 'utf8'), '[chromium] › cart.spec.ts\n[mobile-chrome] › cart.spec.ts\n');

  const refused = run(['select', '--remove', 'e2e/cart.spec.ts', '--reason', 'not affected']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /only allowed after `shadow promote`/);
  const promoted = run(['shadow', 'promote']);
  assert.equal(promoted.code, 0, promoted.out);
  assert.match(promoted.stdout, /^trust selected/);
  const removed = run(['select', '--remove', 'e2e/cart.spec.ts', '--reason', 'not affected']);
  assert.equal(removed.code, 0, removed.out);
  assert.match(removed.stdout, /^removed web: e2e\/cart\.spec\.ts \(not affected\)$/m);
  assert.equal(readFileSync(at('.e2e-rail/test-list.web.txt'), 'utf8'), '');
  const demoted = run(['shadow', 'demote']);
  assert.match(demoted.stdout, /^trust shadow/);
  assert.match(run(['shadow', 'status']).stdout, /^trust shadow · streak 0\/2 · promotable no$/m);

  const mixed = run(['select', '--base', 'HEAD', '--add', 'e2e/cart.spec.ts', '--reason', 'x']);
  assert.equal(mixed.code, 2, mixed.out);
}));

test('B: a full pass or a complete shard merge on a dirty tree says last-green did not move; on a clean tree it moves', () => withRepo(({ root, run, at }) => {
  const DIRTY = 'last-green not moved: the working tree had uncommitted changes';
  const lastGreen = () => (existsSync(at('.e2e-rail/last-green.web')) ? readFileSync(at('.e2e-rail/last-green.web'), 'utf8').trim() : null);
  const head = () => execCapture('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const dirty = run(['run', '--full', '--no-lock']);
  assert.equal(dirty.code, 0, dirty.out);
  assert.ok(dirty.stdout.split('\n').includes(DIRTY), dirty.stdout);
  assert.equal(lastGreen(), null);
  assert.equal(run(['verify']).code, 0, 'the dirty pass still verifies its own code');
  writeFileSync(at('src/components/Table.ts'), 'export const Table = (rows: unknown[]) => rows.length + 3;\n');
  const stale = run(['verify']);
  assert.equal(stale.code, 20, stale.out);
  assert.equal(stale.stdout, 'stale: no passing run for this code · differing: diff · no full pass of a committed tree yet, so no base to narrow from\n');
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  // a complete shard set of the same dirty code
  assert.equal(run(['shard', 'plan', '--count', '1']).code, 0);
  assert.equal(run(['run', '--test-list', '.e2e-rail/shards/web/1.txt', '--shard', '1/1', '--no-lock']).code, 0);
  mkdirSync(at('blob-report'));
  const merged = run(['shard', 'merge', '--dir', 'blob-report']);
  assert.match(merged.stdout, /complete: yes/);
  assert.ok(merged.stdout.split('\n').includes(DIRTY), merged.stdout);
  assert.equal(lastGreen(), null);
  // committed: the same runs move it, and say nothing
  commit(root, ['src/components/Table.ts']);
  const clean = run(['run', '--full', '--no-lock']);
  assert.equal(clean.code, 0, clean.out);
  assert.doesNotMatch(clean.out, /last-green not moved/);
  assert.equal(lastGreen(), head());
  rmSync(at('.e2e-rail/last-green.web'));
  assert.equal(run(['shard', 'plan', '--count', '1']).code, 0);
  assert.equal(run(['run', '--test-list', '.e2e-rail/shards/web/1.txt', '--shard', '1/1', '--no-lock']).code, 0);
  const cleanMerge = run(['shard', 'merge', '--dir', 'blob-report']);
  assert.match(cleanMerge.stdout, /complete: yes/);
  assert.doesNotMatch(cleanMerge.out, /last-green not moved/);
  assert.equal(lastGreen(), head());
}));

test('shard plan → each list run as its shard → merge reports complete; a list without a plan is noted as adhoc', () => withRepo(({ root, run, at }) => {
  const p = run(['shard', 'plan', '--count', '2']);
  assert.equal(p.code, 0, p.out);
  assert.match(p.stdout, /^manifest: \.e2e-rail\/shards\/web\/manifest\.json$/m);
  assert.match(p.stdout, /^shard 1\/2 · /m);
  for (const i of [1, 2]) {
    const r = run(['run', '--test-list', `.e2e-rail/shards/web/${i}.txt`, '--shard', `${i}/2`, '--no-lock']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /kind shard/);
    assert.doesNotMatch(r.stdout, /adhoc/);
  }
  const plan = JSON.parse(readFileSync(at('.e2e-rail/shards/web/manifest.json'), 'utf8'));
  assert.ok(ledgerLines(root).every((e) => e.shard.plan === plan.planId));
  mkdirSync(at('blob-report'));
  const m = run(['shard', 'merge', '--dir', 'blob-report']);
  assert.equal(m.code, 0, m.out);
  assert.match(m.stdout, /complete: yes/);
  assert.equal(run(['verify']).code, 0);

  const wrong = run(['run', '--test-list', '.e2e-rail/shards/web/1.txt', '--shard', '1/3', '--no-lock']);
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.stderr, /^e2e-rail: \S+1\.txt is shard 1\/2 of plan plan-\S+, not 1\/3/);
  const missing = run(['run', '--test-list', 'nope.txt', '--no-lock']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^e2e-rail: test list not found: /);

  writeFileSync(at('mine.txt'), '[chromium] › orders.spec.ts\n');
  const adhoc = run(['run', '--test-list', 'mine.txt', '--shard', '1/2', '--no-lock']);
  assert.equal(adhoc.code, 0, adhoc.out);
  assert.match(adhoc.stdout, /^note: .*adhoc/m);
  assert.match(ledgerLines(root).at(-1).shard.plan, /^adhoc:/);

  // I6: a plan lists the tests in the env of the mode its shards run in, and says how to run them
  const preview = run(['shard', 'plan', '--count', '2', '--mode', 'preview']);
  assert.equal(preview.code, 0, preview.out);
  assert.match(preview.stdout, /^plan plan-\S+ · app web · mode preview · 2 shard\(s\)/m);
  assert.match(preview.stdout, /^run each: e2e-rail run --app web --test-list \.e2e-rail\/shards\/web\/<i>\.txt --shard <i>\/2 --mode preview$/m);
  assert.equal(JSON.parse(readFileSync(at('.e2e-rail/shards/web/manifest.json'), 'utf8')).mode, 'preview');
  assert.equal(run(['shard', 'plan', '--count', '2', '--mode', 'staging']).code, 2);
}));

test('measure slowest / retries / workers print tables from the ledger', () => withRepo(({ run, at }) => {
  const none = run(['measure', 'slowest']);
  assert.equal(none.code, 0, none.out);
  assert.match(none.stdout, /no whole-suite run of app web in the ledger yet/);
  assert.equal(run(['run', '--full', '--no-lock']).code, 0);
  const s = run(['measure', 'slowest', '-n', '2']);
  assert.equal(s.code, 0, s.out);
  const rows = s.stdout.trim().split('\n');
  assert.equal(rows.length, 3); // header + 2
  assert.match(rows[0], /^file\s+project\s+duration$/);
  assert.match(rows[1], /^e2e\/cart\.spec\.ts\s+mobile-chrome\s+1\.5s$/);
  const r = run(['measure', 'retries', '--last', '5']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^file\s+project\s+runs\s+retried\s+rate$/m);
  assert.match(r.stdout, /^e2e\/cart\.spec\.ts\s+chromium\s+1\s+0\s+0%$/m);

  writeFileSync(at('list.txt'), '[chromium] › orders.spec.ts\n');
  const w = run(['measure', 'workers', '1,2', '--test-list', 'list.txt']);
  assert.equal(w.code, 0, w.out);
  assert.match(w.stdout, /^workers\s+rc\s+duration\s+failures\s+retried\s+load$/m);
  assert.match(w.stdout, /^1\s+0\s+\S+\s+0\s+0\s+\S+$/m);
  assert.match(w.stdout, /^2\s+0\s+\S+\s+0\s+0\s+\S+$/m);
  const missing = run(['measure', 'workers', '1', '--test-list', 'nope.txt']);
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.stderr, /^e2e-rail: test list not found: /);
}));

test('lock run holds the lock around a command and passes its rc through; status and reap need no config', () => withRepo(({ run, lockRoot }) => {
  assert.equal(run(['lock', 'run', 'light', '--', process.execPath, '-e', 'process.exit(3)']).code, 3);
  const missing = run(['lock', 'run', 'light', '--', 'e2e-rail-no-such-command', 'x']);
  assert.equal(missing.code, 127, missing.out);
  assert.equal(missing.stderr, 'e2e-rail: cannot run e2e-rail-no-such-command: command not found (ENOENT)\n');
  const nested = run(['lock', 'run', 'heavy', '--', process.execPath, bin, 'lock', 'status']);
  assert.equal(nested.code, 0, nested.out);
  assert.match(nested.stdout, /^heavy: pid \d+ lock run: .* since \S+/m);
  const st = run(['lock', 'status']);
  assert.equal(st.code, 0, st.out);
  assert.match(st.stdout, /heavy/);
  assert.match(st.stdout, /^heavy: free$/m);
  assert.match(st.stdout, /^light: free$/m);
  withEmptyDir((dir) => {
    const reap = cli(dir, ['lock', 'reap'], { E2E_RAIL_LOCK_DIR: lockRoot });
    assert.equal(reap.code, 0, reap.out);
    assert.match(reap.stdout, /^reaped: none$/m);
  });
}));
