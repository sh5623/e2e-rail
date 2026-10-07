import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { execCapture } from './exec.mjs';

// e2e-rail ships no Playwright of its own: it drives the host's @playwright/test.
function hostRequire(appDirAbs) {
  return createRequire(path.join(appDirAbs, 'package.json'));
}

function missing(appDirAbs, cause) {
  return new Error(`@playwright/test not found from ${appDirAbs}. Install it in the app (devDependency) — e2e-rail borrows the host Playwright. (${cause.message.split('\n')[0]})`);
}

export function playwrightCli(appDirAbs) {
  try {
    return hostRequire(appDirAbs).resolve('@playwright/test/cli');
  } catch (e) {
    throw missing(appDirAbs, e);
  }
}

export function playwrightVersion(appDirAbs) {
  try {
    return hostRequire(appDirAbs)('@playwright/test/package.json').version;
  } catch (e) {
    throw missing(appDirAbs, e);
  }
}

// D: selected and shard runs hand Playwright `--test-list`, which @playwright/test has from 1.56.0 (absent in 1.44–1.55).
export const MIN_PLAYWRIGHT = '1.56.0';

// semver order of `version` against `min` (x.y.z): prerelease tags sort below their release; unreadable is below all.
function atLeast(version, min) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(String(version ?? ''));
  if (!m) return false;
  const want = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = Number(m[i + 1]) - want[i];
    if (d) return d > 0;
  }
  return !m[4];
}

// Refuses an app whose @playwright/test is older than MIN_PLAYWRIGHT (or cannot be read). Called before anything lists
// or runs tests (runTests, the spec index, shard plan); an app that passes is not read again in this process.
const supported = new Set();
export function assertPlaywrightSupported(appDirAbs) {
  if (supported.has(appDirAbs)) return;
  const version = playwrightVersion(appDirAbs);
  if (!atLeast(version, MIN_PLAYWRIGHT)) {
    throw new Error(`e2e-rail: @playwright/test ${MIN_PLAYWRIGHT} or newer is required (found ${version}): selected and shard runs use --test-list`);
  }
  supported.add(appDirAbs);
}

// realpath of `p`; when it does not exist, realpath of its nearest existing parent plus the remaining segments.
function realpathLoose(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// App-relative POSIX path of `abs`, symlink-safe on both sides (macOS /var vs /private/var, linked workspaces).
export function toAppRel(appDirAbs, abs) {
  return path.relative(realpathLoose(appDirAbs), realpathLoose(abs)).split(path.sep).join('/');
}

// The JSON reporter's `file` fields are relative to config.rootDir (resolve(configDir, testDir)), not to the app.
// Returns one row per test: { file (app-relative POSIX), title, titlePath, project, status, results }. `titlePath` is
// what a `--test-list` line names after the file: the titles of the enclosing describe blocks (anonymous ones left
// out, as Playwright does) and the test's own title. The top-level suites are the files.
export function flattenSuites(report, appDirAbs) {
  const rootDir = report.config?.rootDir ?? appDirAbs;
  const rel = (file) => toAppRel(appDirAbs, path.resolve(rootDir, file));
  const out = [];
  const visit = (suite, inherited, titles) => {
    const file = suite.file ? rel(suite.file) : inherited;
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ? rel(spec.file) : file;
      for (const t of spec.tests ?? []) {
        out.push({ file: specFile, title: spec.title, titlePath: [...titles, spec.title], project: t.projectName, status: t.status, results: t.results ?? [] });
      }
    }
    for (const s of suite.suites ?? []) visit(s, file, s.title ? [...titles, s.title] : titles);
  };
  for (const s of report.suites ?? []) visit(s, undefined, []);
  return out;
}

// D: from 1.58.0 a `--test-list` line names a title-path prefix (a file, a describe, a test); 1.56–1.57 match a line
// only against a test's whole title path, so a line naming a file matches nothing there.
export const TEST_LIST_PREFIXES = '1.58.0';
export const testListTakesPrefixes = (version) => atLeast(version, TEST_LIST_PREFIXES);

// `playwright test --list` -> { rootDir, cases }
//   rootDir: app-relative POSIX path of config.rootDir ('' when it is the app dir). `--test-list` lines are
//            matched against path.relative(rootDir, file), so callers need it to write them.
//   cases:   one per (test, project): { file (app-relative), project, titlePath }, in Playwright's order
// `env` is the run environment of the mode the tests will run in (config runEnv): a Playwright config may choose its
// projects or testDir by env, so a listing without it can name other tests than the run will see.
export function listTestCases(appDirAbs, configRel, env = {}) {
  const r = execCapture('node', [playwrightCli(appDirAbs), 'test', '--list', '--reporter=json', '--config', configRel], {
    cwd: appDirAbs,
    // A CI-wide JSON output path would divert the listing from stdout to a file.
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: undefined, PLAYWRIGHT_JSON_OUTPUT_NAME: undefined },
  });
  if (r.status !== 0) throw new Error(`playwright --list failed:\n${r.stderr || r.stdout}`);
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`playwright --list did not print JSON:\n${(r.stdout || r.stderr).slice(0, 500)}`);
  }
  const rootDir = report.config?.rootDir ? toAppRel(appDirAbs, report.config.rootDir) : '';
  const cases = flattenSuites(report, appDirAbs).map(({ file, project, titlePath }) => ({ file, project, titlePath }));
  return { rootDir, cases };
}

// `playwright test --list` -> { rootDir, tests: { [specRelToApp]: sorted project names } } (see listTestCases)
export function listTests(appDirAbs, configRel, env = {}) {
  const { rootDir, cases } = listTestCases(appDirAbs, configRel, env);
  const tests = {};
  for (const t of cases) {
    const projects = (tests[t.file] ??= []);
    if (!projects.includes(t.project)) projects.push(t.project);
  }
  for (const k of Object.keys(tests)) tests[k].sort();
  return { rootDir, tests };
}
