import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, findApp, ledgerDir } from './config.mjs';
import { matchAny, matchGlob, walk } from './util/glob.mjs';
import { gitChangedFiles, gitDiffHash, gitHead, gitLocation, gitUncommittedFiles, gitUntrackedHash } from './util/git.mjs';
import { sha256 } from './util/hash.mjs';
import { newId } from './util/id.mjs';
import { loadTypeScript } from './util/ts.mjs';
import { loadOrBuildSpecIndex, routeMatches, slugOf } from './spec-index.mjs';
import { affectedEntries, apiLiterals, findMain, loadOrBuildGraph } from './graph.mjs';
import { getAdapter } from './adapters/index.mjs';

// The selector (spec §6): which Playwright specs a change can reach, and why. It may select too much, never too little
// by a guess: whatever it cannot attribute (no base, a file outside every rule, an unreadable route table, a blind spot
// in the import graph) makes that app run in full, with the reason recorded.

const SPEC_RE = /\.spec\.[cm]?[tj]sx?$/; // the spec index's rule for spec files
const toPosix = (p) => p.split(path.sep).join('/');
// A configured directory as a clean relative POSIX prefix; '' is the base itself.
const dirRel = (d) => {
  const n = path.posix.normalize(toPosix(String(d))).replace(/\/+$/, '');
  return n === '.' ? '' : n;
};
const under = (rel, dir) => dir === '' || rel.startsWith(`${dir}/`);
const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

// The ledger dir relative to the config root, when it lies inside it (its files are e2e-rail's own output).
export function ledgerRel(config) {
  const d = dirRel(config.ledger.dir);
  return d === '' || d === '..' || d.startsWith('../') || path.posix.isAbsolute(d) ? null : d;
}

// The app whose root holds `rel`; the deepest root wins when roots nest (an app at '.' and another at apps/x).
function owningApp(config, rel) {
  let best = null;
  for (const app of config.apps) {
    const root = dirRel(app.root);
    if ((root === '' || rel === root || rel.startsWith(`${root}/`)) && (!best || root.length > best.root.length)) best = { app, root };
  }
  if (!best) return null;
  return { app: best.app, appRel: best.root === '' ? rel : rel.slice(best.root.length + 1) };
}

// One changed path (relative to the config root) → the first matching row of the table in spec §6.
export function classifyFile(config, repoRel) {
  const rel = path.posix.normalize(toPosix(repoRel)).replace(/^\.\//, '');
  // Outside the config root (git reports the whole repository, R39): no glob or app root of this config describes it.
  if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return { kind: 'unknown-root', reason: `unknown-root:${rel}` };
  const ledger = ledgerRel(config);
  if (matchAny(config.ignore, rel) || (ledger && under(rel, ledger))) return { kind: 'ignore', reason: 'ignore' };
  const owner = owningApp(config, rel);
  if (owner && matchAny(owner.app.tiers.ignore, owner.appRel)) return { kind: 'ignore', ...owner, reason: 'ignore' };
  if (matchAny(config.shared, rel)) return { kind: 'shared', reason: `shared:${rel}` };
  if (!owner) return { kind: 'unknown-root', reason: `unknown-root:${rel}` };
  const { app, appRel } = owner;
  const full = app.tiers.full.find((g) => matchGlob(g, appRel));
  if (full) return { kind: 'tier-full', ...owner, reason: `tier-full:${full}` };
  if (under(appRel, dirRel(app.specDir)) && SPEC_RE.test(appRel)) return { kind: 'spec', ...owner, reason: `spec-self:${appRel}` };
  if (app.supportDirs.some((d) => under(appRel, dirRel(d)))) return { kind: 'support', ...owner, reason: `support:${appRel}` };
  if (under(appRel, dirRel(app.srcDir))) return { kind: 'src', ...owner, reason: `src:${appRel}` };
  return { kind: 'app-other', ...owner, reason: `app-other:${appRel}` };
}

// Can a spec's route() glob intercept a request made with this literal? A literal ending in `*` has a dynamic tail
// (apiLiterals cut `/api/orders/${id}/items` to `/api/orders/*`), so the question is whether the glob accepts some
// URL that starts with the fixed part. The glob's leading `**` stands for the origin and may also take whole leading
// segments of the fixed part, but never all of it (else every `**/…` glob would match every dynamic literal).
export function apiMatches(glob, literal) {
  const g = glob.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, ''); // `http://host/api/x` → `/api/x`
  if (!literal.endsWith('*')) return matchGlob(glob, literal) || matchGlob(g, literal);
  const p = literal.slice(0, -1);
  const rec = (gi, si) => {
    if (si === p.length) return true; // the rest of the glob falls in the dynamic tail
    if (gi === g.length) return false;
    if (g[gi] === '*' && g[gi + 1] === '*') {
      const slash = g[gi + 2] === '/';
      const rest = slash ? gi + 3 : gi + 2;
      if (rest === g.length || gi > 0) return true; // a trailing or inner `**` takes the rest of the fixed part
      for (let k = si; k < p.length; k++) if ((!slash || k === si || p[k - 1] === '/') && rec(rest, k)) return true;
      return false;
    }
    if (g[gi] === '*') {
      for (let k = si; k <= p.length; k++) {
        if (rec(gi + 1, k)) return true;
        if (p[k] === '/') break;
      }
      return false;
    }
    if (g[gi] === '?') return p[si] !== '/' && rec(gi + 1, si + 1);
    return g[gi] === p[si] && rec(gi + 1, si + 1);
  };
  return rec(0, 0);
}

// Every graph node that depends on one of `starts` (inclusive): a spec importing any of them runs changed code.
function dependents(graph, starts) {
  const seen = new Set(starts);
  const queue = [...seen];
  for (let i = 0; i < queue.length; i++) {
    for (const importer of graph.reverse[queue[i]] ?? []) {
      if (!seen.has(importer)) { seen.add(importer); queue.push(importer); }
    }
  }
  return seen;
}

// Narrows one app from its spec and src changes. `c` = ctx.forApp(app). Any blind spot calls widen().
function narrow(config, app, p, c) {
  const { index, graph, entries, unresolvedEntries, main } = c;
  const dirAbs = appDir(config, app);
  const widen = (reason) => { p.mode = 'full'; p.reasons.push(reason); };
  const add = (file, reason) => {
    const cur = p.specs.get(file) ?? { file, projects: [...index.specs[file].projects], reasons: [] };
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    p.specs.set(file, cur);
  };
  p.rootDir = index.rootDir ?? null;

  for (const s of p.spec) {
    if (index.specs[s]) add(s, `spec-self:${s}`);
    else if (existsSync(path.join(dirAbs, s))) widen(`spec-unindexed:${s}`); // on disk but unknown: projects unknown too
    // else: a deleted spec has nothing left to run
  }
  if (!p.src.length) return;

  for (const u of unresolvedEntries) widen(`adapter-unresolved:${u}`);
  const boundary = walk(dirAbs).filter((rel) => matchAny(app.adapter.routeFiles, rel)); // R28: the route tables
  const { entries: hit, unresolved, shell } = affectedEntries(graph, p.src, entries.map((e) => e.file), main, boundary);
  for (const f of unresolved) widen(`graph-unresolved:${f}`);
  for (const f of shell) widen(`graph-shell:${f}`);
  if (p.mode === 'full') return;

  const routes = entries.filter((e) => hit.has(e.file));
  const literals = [...new Set(p.src.flatMap((f) => {
    const abs = path.join(dirAbs, f);
    return existsSync(abs) ? apiLiterals(abs, app.apiPrefix) : [];
  }))];
  const above = dependents(graph, p.src);
  for (const [file, info] of Object.entries(index.specs)) {
    for (const r of routes) for (const sr of info.routes) if (routeMatches(r.route, sr)) add(file, `route:${r.route} ← ${r.file}`);
    for (const g of info.apis) for (const lit of literals) if (apiMatches(g, lit)) add(file, `api:${g} ← ${lit}`);
    for (const imp of info.imports) if (above.has(imp)) add(file, `import:${imp}`);
    // Post-processing (spec §6): with any app source change, specs the index cannot map and alwaysRun ride along.
    // `unmapped` is authoritative even when support helpers lent the spec some routes.
    if (info.unmapped) add(file, 'unmapped');
    if (app.alwaysRun.includes(slugOf(file))) add(file, 'always-run');
  }
  p.unmappedIncluded = [...p.specs.values()].filter((s) => s.reasons.includes('unmapped')).length;
}

// `changedFiles`: paths relative to config.root, or null when the change is unknown (every app runs in full).
// `ctx.forApp(app)` → { index, graph, entries, unresolvedEntries, main }, called only for apps that need narrowing.
// `app`: compute that app only (other apps' files are not its business; shared/unknown-root still widen it).
export async function computeSelection({ config, changedFiles, base = null, head = 'HEAD', includeUncommitted = true, ctx, app = null }) {
  const targets = app ? [findApp(config, app)] : config.apps;
  const sel = { id: newId('sel'), createdAt: new Date().toISOString(), base, head, includeUncommitted, changedFiles, codeId: codeIdOf(config), apps: {} };
  const per = new Map(targets.map((a) => [a.name, { mode: 'partial', reasons: [], rootDir: null, specs: new Map(), unmappedIncluded: 0, changedFiles: [], spec: [], src: [] }]));
  const widen = (name, reason) => {
    const p = per.get(name);
    if (p) { p.mode = 'full'; p.reasons.push(reason); }
  };
  const widenAll = (reason) => { for (const name of per.keys()) widen(name, reason); };

  if (changedFiles === null) widenAll('no-base');
  for (const file of new Set(changedFiles ?? [])) {
    const c = classifyFile(config, file);
    if (c.kind === 'ignore') continue;
    if (c.kind === 'shared' || c.kind === 'unknown-root') { widenAll(c.reason); continue; }
    const p = per.get(c.app.name);
    if (!p) continue; // another app's file under `app`
    p.changedFiles.push(c.appRel);
    if (c.kind === 'spec') p.spec.push(c.appRel);
    else if (c.kind === 'src') p.src.push(c.appRel);
    // tier-full, app-other, and support: the index keeps only a spec's direct support imports, so the specs that
    // reach a helper through another helper are unknown
    else widen(c.app.name, c.reason);
  }

  for (const a of targets) {
    const p = per.get(a.name);
    if (p.mode === 'partial' && (p.spec.length || p.src.length)) narrow(config, a, p, await ctx.forApp(a));
    const full = p.mode === 'full';
    sel.apps[a.name] = {
      mode: p.mode, reasons: [...new Set(p.reasons)], rootDir: p.rootDir,
      specs: full ? [] : [...p.specs.values()].sort(byFile),
      added: [], removed: [], unmappedIncluded: full ? 0 : p.unmappedIncluded, changedFiles: p.changedFiles,
    };
  }
  return sel;
}

// The code the working tree holds: HEAD + uncommitted diff + untracked files (minus e2e-rail's own ledger).
export function codeIdOf(config) {
  const ledger = ledgerRel(config);
  return sha256(`${gitHead(config.root)}\n${gitDiffHash(config.root)}\n${gitUntrackedHash(config.root, ledger ? [`${ledger}/`] : [])}`);
}

// The real ctx: adapter routes, spec index and import graph per app. TypeScript is the caller's or the app's own.
function appContext({ config, ts }) {
  return {
    forApp: async (app) => {
      const t = ts ?? await loadTypeScript(appDir(config, app));
      const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts: t });
      const index = await loadOrBuildSpecIndex({ config, app, ts: t });
      const graph = await loadOrBuildGraph({ config, app, ts: t });
      return { index, graph, entries, unresolvedEntries: unresolved, main: findMain(config, app) };
    },
  };
}

const inCI = () => Boolean(process.env.CI) && !/^(0|false)$/i.test(process.env.CI);

// No base, no work tree, or a diff git cannot compute → changedFiles null → full (spec §6: "unknown" is not
// "no change"). Git reports the whole repository relative to its toplevel; the table speaks config-root-relative, so a
// file outside the config root becomes `../…` and classifies as unknown-root (R39).
export async function select({ config, ts, base, head = 'HEAD', includeUncommitted = !inCI(), app }) {
  const loc = gitLocation(config.root);
  let changed = loc ? gitChangedFiles(config.root, base, head) : null;
  if (changed !== null && includeUncommitted) {
    const uncommitted = gitUncommittedFiles(config.root);
    changed = uncommitted === null ? null : [...changed, ...uncommitted];
  }
  if (changed !== null) {
    const here = `/${loc.prefix.replace(/\/$/, '')}`;
    changed = [...new Set(changed.map((p) => path.posix.relative(here, `/${p}`)))].sort();
  }
  return computeSelection({ config, changedFiles: changed, base: base ?? null, head, includeUncommitted, ctx: appContext({ config, ts }), app });
}

// Playwright `--test-list` lines are matched against the path relative to config.rootDir, so without the spec index's
// rootDir no line can be written (a guessed base makes every line match nothing).
export function testListLines(appSel) {
  if (appSel.specs.length && appSel.rootDir == null) throw new Error('test-list lines need the spec index rootDir, and this selection has none. Run `e2e-rail map` first.');
  return appSel.specs.flatMap((s) => s.projects.map((p) => `[${p}] › ${path.posix.relative(appSel.rootDir, s.file)}`));
}

// `.e2e-rail/test-list.<app>.txt` per partial app (a full app gets none, and loses a stale one), then
// `selections/<id>.json` and `selection.json` (the current selection) last.
export function writeSelection(config, selection) {
  const dir = ledgerDir(config);
  mkdirSync(path.join(dir, 'selections'), { recursive: true });
  const testLists = {};
  for (const [name, a] of Object.entries(selection.apps)) {
    const abs = path.join(dir, `test-list.${name}.txt`);
    if (a.mode === 'full') {
      rmSync(abs, { force: true });
      testLists[name] = null;
      continue;
    }
    const lines = testListLines(a);
    writeFileSync(abs, lines.length ? `${lines.join('\n')}\n` : '');
    testLists[name] = abs;
  }
  const text = `${JSON.stringify(selection, null, 2)}\n`;
  writeFileSync(path.join(dir, 'selections', `${selection.id}.json`), text);
  const selectionAbs = path.join(dir, 'selection.json');
  writeFileSync(selectionAbs, text);
  return { selectionAbs, testLists };
}

export function readSelection(config, id) {
  if (id && !/^[\w.-]+$/.test(id)) throw new Error(`invalid selection id: ${id}`);
  const abs = id ? path.join(ledgerDir(config), 'selections', `${id}.json`) : path.join(ledgerDir(config), 'selection.json');
  if (!existsSync(abs)) throw new Error(`selection not found: ${abs}. Run \`e2e-rail select\` first.`);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function cachedIndex(config, app) {
  try { return JSON.parse(readFileSync(path.join(ledgerDir(config), `map.${app.name}.json`), 'utf8')); } catch { return null; }
}

// Agent corrections to the current selection (spec §6). Adding is always allowed and recorded; removing only after
// `shadow promote`. Everything is validated before the selection changes, so a rejected call leaves no trace.
export function amendSelection(config, { app, add = [], remove = [], allowRemove = false }) {
  if (remove.length && !allowRemove) throw new Error('removing specs from a selection is only allowed after `shadow promote` (trust=selected)');
  const target = findApp(config, app);
  const sel = readSelection(config);
  const a = sel.apps[target.name];
  if (!a) throw new Error(`selection ${sel.id} has no entry for app ${target.name}`);
  const root = dirRel(target.root);
  const specOf = (raw) => {
    const rel = path.posix.normalize(toPosix(String(raw ?? ''))).replace(/^\.\//, '');
    return root && rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel;
  };
  const reasonOf = (x) => {
    const r = typeof x.reason === 'string' ? x.reason.trim() : '';
    if (!r) throw new Error(`a reason is required for ${x.spec}`);
    return r;
  };
  const index = cachedIndex(config, target);
  const adds = add.map((x) => {
    const spec = specOf(x.spec);
    const reason = reasonOf(x);
    const known = index?.specs?.[spec]?.projects;
    if (known) return { spec, reason, projects: [...known] };
    if (!existsSync(path.join(appDir(config, target), spec))) throw new Error(`spec not found in app ${target.name}: ${spec}`);
    return { spec, reason, projects: null };
  });
  const removes = remove.map((x) => {
    const spec = specOf(x.spec);
    const reason = reasonOf(x);
    if (a.mode === 'full') throw new Error(`app ${target.name} runs in full; there is nothing to remove ${spec} from`);
    if (!a.specs.some((s) => s.file === spec)) throw new Error(`${spec} is not in the selection`);
    return { spec, reason };
  });
  // A partial selection that needed no index (docs-only change) has no rootDir; its test-list lines need one.
  let rootDir = a.rootDir ?? null;
  if (adds.length && a.mode !== 'full' && rootDir === null) {
    if (typeof index?.rootDir !== 'string') throw new Error(`app ${target.name}: no spec index yet, so the test-list base (rootDir) is unknown. Run \`e2e-rail map\` first, then add again.`);
    rootDir = index.rootDir;
  }

  a.rootDir = rootDir;
  for (const x of adds) {
    if (a.mode !== 'full') {
      let s = a.specs.find((y) => y.file === x.spec);
      if (!s) {
        if (!x.projects) console.warn(`e2e-rail: ${x.spec} is not in the spec index (map.${target.name}.json); it is added for project chromium only. Run \`e2e-rail map\` to index it.`);
        s = { file: x.spec, projects: x.projects ?? ['chromium'], reasons: [] };
        a.specs.push(s);
      }
      s.reasons.unshift(`added: ${x.reason}`);
    }
    a.added.push({ spec: x.spec, reason: x.reason });
  }
  for (const x of removes) {
    a.specs = a.specs.filter((s) => s.file !== x.spec);
    a.removed.push({ spec: x.spec, reason: x.reason });
  }
  a.specs.sort(byFile);
  a.unmappedIncluded = a.specs.filter((s) => s.reasons.includes('unmapped')).length;
  writeSelection(config, sel);
  return sel;
}

export const selectionExitCode = (sel) => (Object.values(sel.apps).some((a) => a.mode === 'full') ? 10 : 0);
