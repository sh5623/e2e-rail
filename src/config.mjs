import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execCapture } from './util/exec.mjs';
import { sha256 } from './util/hash.mjs';

export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ConfigError';
  }
}
// A hook asked for a project config whose exact bytes no explicit e2e-rail command has run on this machine.
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
const ADAPTER_KEYS = ['name', 'routeFiles', 'basePath', 'map'];
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
// `$E2E_RAIL_HOME/<key>/e2e-rail.config.mjs` (default `~/.e2e-rail`), where <key> is the directory name of the main
// worktree, so every linked worktree of the repository finds the same config. Its default ledger is
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
  const key = path.basename(main);
  const dir = path.join(personalHome(), key);
  const worktree = main === root ? 'main' : `${path.basename(root)}-${sha256(root).slice(0, 8)}`;
  return { root, key, dir, configPath: path.join(dir, CONFIG_FILE), ledgerDefault: path.join(dir, 'ledger', worktree) };
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

// Trusted project configs. A config is JavaScript: loading it runs it. An explicit e2e-rail command is something the
// user (or their permission rules) let run; a runtime hook runs on every prompt with no prompt of its own. So a hook
// loads a project config only when an explicit command already ran those exact bytes on this machine, and every
// explicit command records the bytes it ran: `$E2E_RAIL_HOME/trusted-configs.json` (path → sha256), outside every
// repository. A pull that changes the config silences the hooks until the next explicit command. A personal config
// lives in the user's own E2E_RAIL_HOME and needs no record.
const trustPath = () => path.join(personalHome(), 'trusted-configs.json');
const digestOf = (abs) => sha256(readFileSync(abs));
function readTrust() {
  try {
    const v = JSON.parse(readFileSync(trustPath(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export function isTrusted(abs) {
  const all = readTrust();
  return Object.hasOwn(all, abs) && all[abs] === digestOf(abs);
}
function recordTrust(abs) {
  const all = readTrust();
  const digest = digestOf(abs);
  if (all[abs] === digest) return;
  all[abs] = digest;
  const file = trustPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(`${file}.${process.pid}.tmp`, file);
}

// `hook: true` — called from a runtime hook: an untrusted project config is refused (UntrustedConfigError) before it
// is imported. Otherwise the project config's bytes are recorded as trusted once it loaded.
export async function loadConfig(cwd, { hook = false } = {}) {
  const at = locateConfig(cwd);
  if (!at) {
    const p = personalPaths(cwd);
    throw new ConfigError(`${CONFIG_FILE} not found in ${cwd}${p ? ` nor at ${p.configPath} (personal)` : ''}. Run \`e2e-rail init\` first.`);
  }
  if (hook && at.mode === 'project' && !isTrusted(at.configPath)) {
    throw new UntrustedConfigError(`${at.configPath} has not been run by an explicit e2e-rail command in these exact bytes`);
  }
  // The mtime query defeats the ESM module cache, so a config rewritten in the same process is re-read.
  const mod = await import(`${pathToFileURL(at.configPath).href}?mtime=${statSync(at.configPath).mtimeMs}`);
  const config = withDefaults(mod.default ?? mod, at.root, at);
  if (!hook && at.mode === 'project') {
    try { recordTrust(at.configPath); } catch { /* a read-only home: the hooks stay silent, nothing else changes */ }
  }
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
    return {
      ...a, specDir, supportDirs,
      srcDir, tsconfig: a.tsconfig ?? 'tsconfig.json', apiPrefix: a.apiPrefix ?? '/api',
      alwaysRun: a.alwaysRun ?? [],
      adapter: { basePath: '', routeFiles: [], map: {}, ...a.adapter },
      tiers: {
        full: [...new Set([...supportDirs.map((d) => `${d}/**`), a.playwrightConfig, 'package.json', ...(a.tiers?.full ?? [])])],
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
    ledger: { dir: raw.ledger?.dir ?? ledgerDefault ?? '.e2e-rail' },
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
