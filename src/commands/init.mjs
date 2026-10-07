import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../config.mjs';
import { execCapture } from '../util/exec.mjs';
import { matchGlob, walk } from '../util/glob.mjs';
import { loadTypeScript } from '../util/ts.mjs';
import { parse, printUsage } from './_args.mjs';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', CONFIG_FILE);
const TSCONFIG_LINE = "tsconfig: 'tsconfig.json'";
const ROUTE_FILES = /routeFiles: \[([^\]]*)\]/;
const PW_CONFIG = /(^|\/)playwright\.config\.(ts|js|mjs|cjs)$/;
// The ledger, and what every Playwright run writes next to the app. Left un-ignored, run output changes the untracked
// hash after each run, so no later fingerprint would match a recorded one and `verify` could never pass.
const IGNORED = [
  { pattern: '.e2e-rail/', under: () => ['.'] },
  ...['test-results/', 'playwright-report/', 'blob-report/'].map((pattern) => ({ pattern, under: (apps) => apps.map((a) => a.root) })),
];
const quote = (s) => s.replace(/[\\']/g, '\\$&');
const toPosix = (p) => p.split(path.sep).join('/');

// Every playwright.config.* under the repository (`files`: walk skips node_modules, .git, dist, run output) as an app.
function detectApps(root, files) {
  return files.filter((rel) => PW_CONFIG.test(rel)).map((rel) => {
    const dir = path.posix.dirname(rel);
    let name = null;
    try { name = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')).name?.replace(/^@[^/]+\//, '') || null; } catch { /* no package.json */ }
    return { name: name ?? (dir === '.' ? 'app' : path.posix.basename(dir)), root: dir, playwrightConfig: path.posix.basename(rel) };
  });
}

// The app's tsconfig for alias resolution. A solution-style tsconfig.json (`references`, no compilerOptions.paths, as
// Vite writes it) resolves no alias, so the referenced config that holds `paths` is taken instead.
async function pickTsconfig(appAbs) {
  const fallback = { tsconfig: 'tsconfig.json', note: null };
  if (!existsSync(path.join(appAbs, 'tsconfig.json'))) return fallback;
  let ts;
  try { ts = await loadTypeScript(appAbs); } catch { return fallback; } // map/select report the missing compiler
  const read = (abs) => {
    if (!existsSync(abs)) return null;
    const { config, error } = ts.readConfigFile(abs, ts.sys.readFile);
    return error || !config ? null : ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(abs), undefined, abs);
  };
  const top = read(path.join(appAbs, 'tsconfig.json'));
  const refs = top?.projectReferences ?? [];
  if (!refs.length || top.options.paths) return fallback;
  for (const ref of refs) {
    const abs = ts.resolveProjectReferencePath(ref);
    if (read(abs)?.options.paths) {
      const rel = toPosix(path.relative(appAbs, abs));
      return { tsconfig: rel, note: `tsconfig.json is solution-style (only "references"); using ${rel}, the referenced config that holds compilerOptions.paths` };
    }
  }
  return { tsconfig: 'tsconfig.json', note: 'tsconfig.json is solution-style and none of its references holds compilerOptions.paths; set `tsconfig` in the config to the one that resolves your import aliases' };
}

// The template lists route-table globs for both .ts and .tsx (the glob util has no braces). The adapter reports a glob
// that matches no file as unresolved, which would make every src change of a fresh config run in full, so only the
// globs that match a file of the app are kept. If none does, all stay and `map --check` names them.
function pruneRouteFiles(text, appFiles) {
  const m = ROUTE_FILES.exec(text);
  if (!m) throw new Error('the config template has no `routeFiles: [...]` line');
  const globs = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  const kept = globs.filter((g) => appFiles.some((rel) => matchGlob(g, rel)));
  if (!kept.length) return { text, note: `adapter.routeFiles: no file matches ${globs.join(', ')}; list the app's route table files there (or use the manual adapter)` };
  if (kept.length === globs.length) return { text, note: null };
  return { text: text.replace(m[0], () => `routeFiles: [${kept.map((g) => `'${quote(g)}'`).join(', ')}]`), note: `adapter.routeFiles: ${kept.join(', ')} (template globs that match no file were left out)` };
}

async function writeConfig(root, files, apps) {
  if (!apps.length) throw new Error('no playwright.config.{ts,js,mjs,cjs} found below this directory (node_modules excluded); run init from the repository root');
  const [first, ...more] = apps;
  const { tsconfig, note } = await pickTsconfig(path.join(root, first.root));
  let text = readFileSync(TEMPLATE, 'utf8');
  if (!text.includes(TSCONFIG_LINE)) throw new Error(`the config template has no \`${TSCONFIG_LINE}\` line`);
  text = text
    .replace('__APP_NAME__', () => quote(first.name))
    .replace('__APP_ROOT__', () => quote(first.root))
    .replace('__PW_CONFIG__', () => quote(first.playwrightConfig))
    .replace(TSCONFIG_LINE, () => `tsconfig: '${quote(tsconfig)}'`);
  const prefix = first.root === '.' ? '' : `${first.root}/`;
  const routes = pruneRouteFiles(text, files.filter((rel) => rel.startsWith(prefix)).map((rel) => rel.slice(prefix.length)));
  text = routes.text;
  if (more.length) text += `\n// Other Playwright configs found; add the ones that are apps to apps[]: ${JSON.stringify(more)}\n`;
  writeFileSync(path.join(root, CONFIG_FILE), text);
  console.log(`wrote ${CONFIG_FILE} (app ${first.name} at ${first.root}, ${first.playwrightConfig})`);
  for (const line of [note, routes.note]) if (line) console.log(line);
  if (more.length) console.log(`${more.length} more playwright config(s) found; they are listed at the end of ${CONFIG_FILE}`);
}

// Appends the patterns of IGNORED that git does not ignore yet. `git check-ignore` decides (a rule such as `/.e2e-rail`
// or `**/test-results` already covers its pattern); outside a git work tree the file's own lines are compared.
function ensureIgnored(root, apps) {
  const abs = path.join(root, '.gitignore');
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const lines = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const ignored = (pattern, dir) => {
    const r = execCapture('git', ['check-ignore', '-q', '--no-index', '--', path.posix.join(dir, pattern, 'e2e-rail-probe')], { cwd: root });
    return r.status === 0 || (r.status !== 1 && (lines.has(pattern) || lines.has(`/${pattern}`)));
  };
  const dirs = apps.length ? apps : [{ root: '.' }];
  const missing = IGNORED.filter(({ pattern, under }) => !under(dirs).every((dir) => ignored(pattern, dir))).map((x) => x.pattern);
  if (!missing.length) return;
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  appendFileSync(abs, `${lead}${text ? '\n' : ''}# e2e-rail: ledger and caches; Playwright run output (un-ignored, it would change the fingerprint after every run)\n${missing.join('\n')}\n`);
  console.log(`added to .gitignore: ${missing.join(', ')}`);
}

export default async function init(argv) {
  const { values, help } = parse(argv, { force: { type: 'boolean' } });
  if (help) return printUsage('init');
  const root = process.cwd();
  const files = walk(root);
  const apps = detectApps(root, files);
  if (existsSync(path.join(root, CONFIG_FILE)) && !values.force) console.log(`${CONFIG_FILE} exists; left unchanged (use --force to overwrite)`);
  else await writeConfig(root, files, apps);
  ensureIgnored(root, apps);
  const app = apps[0]?.name ?? '<app>';
  console.log([
    '',
    'suggested package.json scripts:',
    `  "e2e:select": "e2e-rail select --base $(cat .e2e-rail/last-green.${app} 2>/dev/null)"`,
    '  "e2e:run":    "e2e-rail run --selection"',
    '  "e2e:verify": "e2e-rail verify --require full"',
    '',
    'next: e2e-rail map --check',
  ].join('\n'));
  return 0;
}
