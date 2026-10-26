import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execCapture } from './util/exec.mjs';
import { matchGlob } from './util/glob.mjs';
import { sha256 } from './util/hash.mjs';

export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ConfigError';
  }
}
// A hook asked for a config whose exact bytes no explicit e2e-rail command has recorded on this machine.
export class UntrustedConfigError extends ConfigError {
  constructor(message) {
    super(message);
    this.name = 'UntrustedConfigError';
  }
}
export const CONFIG_FILE = 'e2e-rail.config.mjs';
const ADAPTERS = new Set(['react-router-lazy', 'manual']);

const TOP_KEYS = ['apps', 'shared', 'ignore', 'shadow', 'ledger', 'autopilot'];
const APP_KEYS = [
  'name', 'root', 'playwrightConfig', 'specDir', 'supportDirs', 'srcDir', 'tsconfig',
  'adapter', 'apiPrefix', 'alwaysRun', 'tiers', 'run', 'main',
];
const ADAPTER_KEYS = ['name', 'routeFiles', 'basePath', 'map', 'unreadable'];
const TIERS_KEYS = ['full', 'ignore'];
const RUN_KEYS = ['port', 'preview', 'workers', 'modeEnv', 'env'];

// Unknown keys are reported, never fatal (spec §3).
function warnUnknown(obj, known, where) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) console.warn(`e2e-rail: unknown config key "${key}" in ${where} (ignored)`);
  }
}

function assertGlobArray(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((g) => typeof g !== 'string')) {
    throw new ConfigError(`${label} must be an array of glob strings`);
  }
}

// Unit tests next to the source and Markdown never trigger a run. Only under srcDir: Playwright's default testMatch
// takes `*.test.*` too, so a bare `**/*.test.ts` would hide E2E specs (a test file under specDir is never ignored).
function defaultIgnore(srcDir) {
  const base = path.posix.normalize(String(srcDir).split(path.sep).join('/')).replace(/\/+$/, '');
  const under = base === '.' || base === '' ? '' : `${base}/`;
  return [`${under}**/*.test.ts`, `${under}**/*.test.tsx`, `${under}**/*.spec.ts`, `${under}**/*.spec.tsx`, '**/*.md'];
}

// Personal mode: a tool one person runs needs no file in the repository. Its config lives in
// `$E2E_RAIL_HOME/<key>/e2e-rail.config.mjs` (default `~/.e2e-rail`), where <key> is `<name>-<sha8>`: the directory
// name of the main worktree and a hash of the repository's real git directory (shared by all its worktrees). Every
// linked worktree of the repository finds the same config, and a same-named repository elsewhere gets its own (0.3.0
// to 0.3.2 keyed by the name alone: `legacyDir`, never read, only named). Its default ledger is
// `$E2E_RAIL_HOME/<key>/ledger/<worktree>`: `main` for the main worktree, `<dir>-<sha8 of its path>` for a linked one,
// so selections and ledgers of different work trees never mix. The config root is the work tree's toplevel.
// null outside a git work tree.
export const personalHome = () => process.env.E2E_RAIL_HOME || path.join(homedir(), '.e2e-rail');
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
export function personalPaths(cwd) {
  const top = execCapture('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.status !== 0 || !top.stdout.trim()) return null;
  const root = real(top.stdout.trim());
  const list = execCapture('git', ['worktree', 'list', '--porcelain'], { cwd });
  const first = /^worktree (.+)$/m.exec(list.stdout)?.[1];
  const main = first ? real(first) : root;
  let common = execCapture('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (common.status !== 0) common = execCapture('git', ['rev-parse', '--git-common-dir'], { cwd }); // git < 2.31
  if (common.status !== 0 || !common.stdout.trim()) return null;
  const key = `${path.basename(main)}-${sha256(real(path.resolve(cwd, common.stdout.trim()))).slice(0, 8)}`;
  const dir = path.join(personalHome(), key);
  const worktree = main === root ? 'main' : `${path.basename(root)}-${sha256(root).slice(0, 8)}`;
  return {
    root, key, dir, configPath: path.join(dir, CONFIG_FILE), ledgerDefault: path.join(dir, 'ledger', worktree),
    legacyDir: path.join(personalHome(), path.basename(main)),
  };
}

// Where the config is: `<cwd>/e2e-rail.config.mjs` (project mode, root = cwd), else the personal one (root = the work
// tree's toplevel). A project config always wins. null when there is neither.
export function locateConfig(cwd) {
  const project = path.join(cwd, CONFIG_FILE);
  if (existsSync(project)) return { mode: 'project', root: cwd, configPath: project, ledgerDefault: null };
  const p = personalPaths(cwd);
  if (p && existsSync(p.configPath)) return { mode: 'personal', root: p.root, configPath: p.configPath, ledgerDefault: p.ledgerDefault };
  return null;
}

// Recorded configs. A config is JavaScript: loading it runs it, and whatever it imports. An explicit e2e-rail command
// is something the user (or their permission rules) let run; a runtime hook runs on every prompt with no prompt of its
// own. So a hook runs no repository code at all: every explicit command records the data its config produced, with
// the sha256 of the config file's bytes, in `$E2E_RAIL_HOME/recorded-configs.json` (outside every repository), and a
// hook rebuilds the config from that data, and only while the file still holds those bytes. A pull that changes the
// config silences the hooks until the next explicit command. (A change to a file the config imports is not seen until
// then either; the hook never runs it.)
const recordPath = () => path.join(personalHome(), 'recorded-configs.json');
const digestOf = (abs) => sha256(readFileSync(abs));
function readRecords() {
  try {
    const v = JSON.parse(readFileSync(recordPath(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
// The real path of `p` (which may not exist yet): its nearest existing ancestor resolved, the rest appended.
export function realPathOf(p) {
  let q = path.resolve(p);
  while (!existsSync(q) && path.dirname(q) !== q) q = path.dirname(q);
  return path.join(realpathSync(q), path.relative(q, path.resolve(p)));
}

// `ledgers`: per config root, the real path of the ledger dir the explicit command used. A hook touches a ledger only
// at that real path, so a link that appears on the way later (a pull turning a directory into a link) silences it.
// Kept while the config's bytes stay the same; not updated when E2E_RAIL_LEDGER_DIR moved the ledger for one command.
function recordConfig(abs, raw, { root, ledger }) {
  const data = JSON.parse(JSON.stringify(raw)); // plain data only; a config that is not JSON-shaped is not recorded
  const all = readRecords();
  const sha = digestOf(abs);
  const prev = all[abs]?.sha256 === sha && all[abs].ledgers && typeof all[abs].ledgers === 'object' ? all[abs].ledgers : {};
  all[abs] = { sha256: sha, data, ledgers: ledger ? { ...prev, [root]: ledger } : prev };
  const file = recordPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { flag: 'wx' });
  renameSync(tmp, file);
}
function recorded(abs) {
  const rec = readRecords()[abs];
  return rec && typeof rec === 'object' && rec.sha256 === digestOf(abs) && rec.data && typeof rec.data === 'object' ? rec : null;
}

// `hook: true` — called from a runtime hook: no module is imported; the config is rebuilt from the data an explicit
// command recorded for these exact bytes, else UntrustedConfigError. Otherwise the config is imported and its data
// recorded.
export async function loadConfig(cwd, { hook = false } = {}) {
  const at = locateConfig(cwd);
  if (!at) {
    const p = personalPaths(cwd);
    const legacy = p && path.join(p.legacyDir, CONFIG_FILE);
    if (legacy && existsSync(legacy)) {
      throw new ConfigError(`${CONFIG_FILE} not found in ${cwd} nor at ${p.configPath} (personal). ${legacy} is where e2e-rail 0.3.0–0.3.2 kept a personal config, by directory name alone, which other repositories of that name share: if it belongs to this repository, move it (mv ${p.legacyDir} ${p.dir}).`);
    }
    throw new ConfigError(`${CONFIG_FILE} not found in ${cwd}${p ? ` nor at ${p.configPath} (personal)` : ''}. Run \`e2e-rail init\` first.`);
  }
  if (hook) {
    const rec = recorded(at.configPath);
    if (!rec) throw new UntrustedConfigError(`${at.configPath} has no data recorded by an explicit e2e-rail command for these exact bytes`);
    const config = withDefaults(rec.data, at.root, at);
    const ledger = rec.ledgers?.[at.root];
    return { ...config, recordedLedger: typeof ledger === 'string' ? ledger : null };
  }
  // The mtime query defeats the ESM module cache, so a config rewritten in the same process is re-read.
  const mod = await import(`${pathToFileURL(at.configPath).href}?mtime=${statSync(at.configPath).mtimeMs}`);
  const raw = mod.default ?? mod;
  const config = withDefaults(raw, at.root, at);
  try {
    recordConfig(at.configPath, raw, { root: at.root, ledger: process.env.E2E_RAIL_LEDGER_DIR ? null : realPathOf(ledgerDir(config)) });
  } catch { /* a read-only home or a non-JSON config: the hooks stay silent */ }
  return config;
}

// `mode`, `configPath`: where loadConfig found the file (project mode, `<root>/e2e-rail.config.mjs`, by default).
// `ledgerDefault`: the ledger dir when the config names none (personal mode: outside the repository).
export function withDefaults(raw, root, { checkFiles = true, mode = 'project', configPath = path.join(root, CONFIG_FILE), ledgerDefault = null } = {}) {
  if (!raw || !Array.isArray(raw.apps) || raw.apps.length === 0) throw new ConfigError('config.apps must be a non-empty array');
  warnUnknown(raw, TOP_KEYS, 'config');
  assertGlobArray(raw.shared, 'config.shared');
  assertGlobArray(raw.ignore, 'config.ignore');
  const apps = raw.apps.map((a) => {
    if (!a.name || !a.root || !a.playwrightConfig) throw new ConfigError(`app needs name, root, playwrightConfig: ${JSON.stringify(a)}`);
    if (!a.adapter?.name || !ADAPTERS.has(a.adapter.name)) throw new ConfigError(`app ${a.name}: unknown adapter ${a.adapter?.name}`);
    if (checkFiles && !existsSync(path.join(root, a.root, a.playwrightConfig))) throw new ConfigError(`app ${a.name}: ${a.playwrightConfig} not found under ${a.root}`);
    assertGlobArray(a.tiers?.full, `app ${a.name}: tiers.full`);
    assertGlobArray(a.tiers?.ignore, `app ${a.name}: tiers.ignore`);
    warnUnknown(a, APP_KEYS, `app ${a.name}`);
    warnUnknown(a.adapter, ADAPTER_KEYS, `app ${a.name} adapter`);
    warnUnknown(a.tiers, TIERS_KEYS, `app ${a.name} tiers`);
    warnUnknown(a.run, RUN_KEYS, `app ${a.name} run`);
    const specDir = a.specDir ?? 'e2e';
    const supportDirs = a.supportDirs ?? [`${specDir}/support`];
    const srcDir = a.srcDir ?? 'src';
    const full = [...new Set([...supportDirs.map((d) => `${d}/**`), a.playwrightConfig, 'package.json', ...(a.tiers?.full ?? [])])];
    // Route modules the adapter is told not to read (a helper-built group). Their routes are never entries, so the
    // only thing that keeps them from vanishing is that an edit to such a module runs the app in full: each must be
    // matched by a tiers.full glob, or the config is refused.
    const unreadable = a.adapter.unreadable ?? [];
    if (!Array.isArray(unreadable) || unreadable.some((f) => typeof f !== 'string')) throw new ConfigError(`app ${a.name}: adapter.unreadable must be an array of app-relative file paths`);
    for (const raw of unreadable) {
      const file = path.posix.normalize(raw.replace(/\\/g, '/'));
      if (/[*?]/.test(file)) throw new ConfigError(`app ${a.name}: adapter.unreadable lists '${raw}': a file path, not a glob`);
      if (!full.some((g) => matchGlob(g, file))) throw new ConfigError(`app ${a.name}: adapter.unreadable lists '${raw}', which no tiers.full glob matches (an edit to it must run the app in full, or its routes could vanish unread)`);
    }
    return {
      ...a, specDir, supportDirs,
      srcDir, tsconfig: a.tsconfig ?? 'tsconfig.json', apiPrefix: a.apiPrefix ?? '/api',
      alwaysRun: a.alwaysRun ?? [],
      adapter: { basePath: '', routeFiles: [], map: {}, ...a.adapter, unreadable: unreadable.map((f) => path.posix.normalize(f.replace(/\\/g, '/'))) },
      tiers: {
        full,
        ignore: a.tiers?.ignore ?? defaultIgnore(srcDir),
      },
      run: {
        port: a.run?.port, preview: a.run?.preview ?? null,
        workers: { local: a.run?.workers?.local, ci: a.run?.workers?.ci ?? 1 },
        // The plugin never injects repo env (spec §9): modes start empty, the repo declares its own.
        modeEnv: { dev: {}, preview: {}, ...(a.run?.modeEnv ?? {}) },
        env: a.run?.env ?? {},
      },
    };
  });
  return {
    root, apps, mode, configPath,
    // `false` turns the runtime hooks off (the Stop check and the direct-Playwright note); skills work either way.
    autopilot: raw.autopilot !== false,
    shared: raw.shared ?? [], ignore: raw.ignore ?? ['**/*.md', 'docs/**'],
    shadow: { promoteAfter: raw.shadow?.promoteAfter ?? 3 },
    // E2E_RAIL_LEDGER_DIR moves the ledger for the commands it is set for (a seeded-failure drill), whatever the config
    // says: an absolute ledger dir would otherwise be shared by every copy of the config.
    ledger: { dir: (process.env.E2E_RAIL_LEDGER_DIR || null) ?? raw.ledger?.dir ?? ledgerDefault ?? '.e2e-rail' },
  };
}

export const appDir = (config, app) => path.resolve(config.root, app.root);
// The environment Playwright gets for `mode`: run.env, then the mode's own (spec §9: the repo declares both). Listing
// tests uses it too, since a config may pick projects or testDir by env.
export const runEnv = (app, mode = 'dev') => ({ ...app.run.env, ...(app.run.modeEnv[mode] ?? {}) });
// A relative ledger dir is under the config root; personal mode's default is absolute (outside the repository).
export const ledgerDir = (config) => path.resolve(config.root, config.ledger.dir);
export function findApp(config, name) {
  if (name) { const a = config.apps.find((x) => x.name === name); if (!a) throw new ConfigError(`unknown app ${name}`); return a; }
  if (config.apps.length === 1) return config.apps[0];
  throw new ConfigError(`several apps configured (${config.apps.map((a) => a.name).join(', ')}); pass --app <name>`);
}
