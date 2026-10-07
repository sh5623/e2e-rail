import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ConfigError';
  }
}
export const CONFIG_FILE = 'e2e-rail.config.mjs';
const ADAPTERS = new Set(['react-router-lazy', 'manual']);

const TOP_KEYS = ['apps', 'shared', 'ignore', 'shadow', 'ledger'];
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

export async function loadConfig(root) {
  const abs = path.join(root, CONFIG_FILE);
  if (!existsSync(abs)) throw new ConfigError(`${CONFIG_FILE} not found in ${root}. Run \`e2e-rail init\` first.`);
  // The mtime query defeats the ESM module cache, so a config rewritten in the same process is re-read.
  const mod = await import(`${pathToFileURL(abs).href}?mtime=${statSync(abs).mtimeMs}`);
  return withDefaults(mod.default ?? mod, root);
}

export function withDefaults(raw, root, { checkFiles = true } = {}) {
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
    root, apps,
    shared: raw.shared ?? [], ignore: raw.ignore ?? ['**/*.md', 'docs/**'],
    shadow: { promoteAfter: raw.shadow?.promoteAfter ?? 3 },
    ledger: { dir: raw.ledger?.dir ?? '.e2e-rail' },
  };
}

export const appDir = (config, app) => path.resolve(config.root, app.root);
// The environment Playwright gets for `mode`: run.env, then the mode's own (spec §9: the repo declares both). Listing
// tests uses it too, since a config may pick projects or testDir by env.
export const runEnv = (app, mode = 'dev') => ({ ...app.run.env, ...(app.run.modeEnv[mode] ?? {}) });
export const ledgerDir = (config) => path.join(config.root, config.ledger.dir);
export function findApp(config, name) {
  if (name) { const a = config.apps.find((x) => x.name === name); if (!a) throw new ConfigError(`unknown app ${name}`); return a; }
  if (config.apps.length === 1) return config.apps[0];
  throw new ConfigError(`several apps configured (${config.apps.map((a) => a.name).join(', ')}); pass --app <name>`);
}
