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

// `playwright test --list` -> { rootDir, tests }
//   rootDir: app-relative POSIX path of config.rootDir ('' when it is the app dir). `--test-list` lines are
//            matched against path.relative(rootDir, file), so callers need it to write them.
//   tests:   { [specRelToApp]: sorted project names }
export function listTests(appDirAbs, configRel) {
  const r = execCapture('node', [playwrightCli(appDirAbs), 'test', '--list', '--reporter=json', '--config', configRel], {
    cwd: appDirAbs,
    // A CI-wide JSON output path would divert the listing from stdout to a file.
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: undefined, PLAYWRIGHT_JSON_OUTPUT_NAME: undefined },
  });
  if (r.status !== 0) throw new Error(`playwright --list failed:\n${r.stderr || r.stdout}`);
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    throw new Error(`playwright --list did not print JSON:\n${(r.stdout || r.stderr).slice(0, 500)}`);
  }
  const tests = {};
  for (const t of flattenSuites(report, appDirAbs)) {
    const projects = (tests[t.file] ??= []);
    if (!projects.includes(t.project)) projects.push(t.project);
  }
  for (const k of Object.keys(tests)) tests[k].sort();
  const rootDir = report.config?.rootDir ? toAppRel(appDirAbs, report.config.rootDir) : '';
  return { rootDir, tests };
}
