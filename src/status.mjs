import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { lastGreenRun } from './ledger.mjs';
import { classifyFile, codeIdOf, ledgerRel, readSelection, reviewState } from './select.mjs';
import { shadowStatus } from './shadow.mjs';
import { gitChangedFiles, gitHead, gitLocation, gitResolveCommit, gitTreeClean, gitUncommittedFiles } from './util/git.mjs';
import { playwrightVersion } from './util/playwright.mjs';
import { verify } from './verify.mjs';
import { VERSION } from './version.mjs';

// `status` (read-only): is the repository ready, which code does the work tree hold, is it verified per app and mode,
// what changed since each app's last green that E2E can reach, and is the current selection for this code and reviewed.
// One answer for a hook, a skill and a person; it decides nothing and runs nothing.

// Git paths (toplevel-relative) as config-root-relative, the way select classifies them (R39).
export function toConfigRel(config, files) {
  const loc = gitLocation(config.root);
  if (!loc) return files;
  const here = `/${loc.prefix.replace(/\/$/, '')}`;
  return [...new Set(files.map((p) => path.posix.relative(here, `/${p}`)))].sort();
}

// The changed files of `app` E2E can reach since its last clean full pass (`files`, config-root-relative: its own, plus
// shared and unknown-root ones, which reach every app) and how many changed files are ignored. `base: null` with `why`
// when there is no base to diff from.
export function reachOf(config, app) {
  const green = lastGreenRun(config, app.name);
  if (!green) return { base: null, why: 'no clean full pass yet', files: [], ignored: 0 };
  const base = gitResolveCommit(config.root, green.fingerprint.head);
  if (!base) return { base: null, why: `last green ${String(green.fingerprint.head).slice(0, 7)} is not in this clone`, files: [], ignored: 0 };
  const committed = gitChangedFiles(config.root, base, 'HEAD');
  const uncommitted = gitUncommittedFiles(config.root);
  if (committed === null || uncommitted === null) return { base, why: 'git could not diff', files: null, ignored: 0 };
  const files = [];
  let ignored = 0;
  for (const f of toConfigRel(config, [...committed, ...uncommitted])) {
    const c = classifyFile(config, f);
    if (c.kind === 'ignore') ignored += 1;
    else if (c.kind === 'shared' || c.kind === 'unknown-root' || c.app?.name === app.name) files.push(f);
  }
  return { base, files, ignored };
}

// Per mode: verify --require full; when that is not verified, whether a selected run of this code is (`selected`).
function modeStatus(config, app, mode) {
  try {
    const full = verify({ config, app, mode, require: 'full' });
    if (full.status === 'verified') return { status: 'verified', kind: full.shards ? 'shards' : full.run.kind, runId: full.run.id };
    const sel = verify({ config, app, mode, require: 'selected' });
    if (sel.status === 'verified') return { status: 'selected', kind: 'selected', runId: sel.run.id };
    return { status: full.status };
  } catch (e) {
    return { status: 'error', error: String(e?.message ?? e).replace(/^e2e-rail: /, '') };
  }
}

export function computeStatus(config, { apps = config.apps } = {}) {
  const ledger = ledgerRel(config);
  const codeId = codeIdOf(config);
  const shadow = shadowStatus(config);
  const out = {
    version: VERSION,
    config: { mode: config.mode ?? 'project', path: config.configPath, root: config.root },
    ledger: ledgerDir(config),
    code: { codeId, head: gitHead(config.root), clean: gitTreeClean(config.root, ledger ? [`${ledger}/`] : []) },
    trust: shadow.trust, streak: shadow.streak, promoteAfter: shadow.promoteAfter,
    apps: {},
    selection: null,
  };
  for (const app of apps) {
    let playwright = null;
    try { playwright = playwrightVersion(appDir(config, app)); } catch { /* reported as null */ }
    const modes = {};
    for (const mode of app.run.preview ? ['preview', 'dev'] : ['dev']) modes[mode] = modeStatus(config, app, mode);
    out.apps[app.name] = { playwright, modes, reach: reachOf(config, app) };
  }
  let sel = null;
  try { sel = readSelection(config); } catch { /* no selection yet */ }
  if (sel) out.selection = { id: sel.id, forThisCode: sel.codeId === codeId, review: reviewState(sel, codeId) };
  return out;
}

const listed = (files, n = 3) => `${files.slice(0, n).join(', ')}${files.length > n ? ` (+${files.length - n} more)` : ''}`;

export function statusLines(s) {
  const lines = [
    `e2e-rail ${s.version} · ${s.config.mode} config ${s.config.path} · ledger ${s.ledger}`,
    `code ${s.code.codeId.slice(0, 12)} · head ${String(s.code.head).slice(0, 7)} · ${s.code.clean ? 'clean' : 'uncommitted changes'} · trust ${s.trust} · streak ${s.streak}/${s.promoteAfter}`,
  ];
  for (const [name, a] of Object.entries(s.apps)) {
    const modes = Object.entries(a.modes).map(([mode, m]) => {
      if (m.status === 'verified') return `${mode} verified (${m.kind}@${m.runId})`;
      if (m.status === 'selected') return `${mode} selected run passed (${m.runId})`;
      if (m.status === 'error') return `${mode} error (${m.error})`;
      return `${mode} ${m.status}`;
    });
    const r = a.reach;
    const reach = r.base === null ? `reach no base (${r.why})`
      : r.files === null ? `reach unknown (${r.why})`
        : r.files.length ? `reach ${r.files.length} file(s) since ${r.base.slice(0, 7)}: ${listed(r.files)}` : `reach none since ${r.base.slice(0, 7)}`;
    lines.push(`${name}: ${modes.join(' · ')} · ${reach}${a.playwright ? '' : ' · playwright missing'}`);
  }
  if (!s.selection) lines.push('selection: none');
  else {
    const r = s.selection.review;
    const review = r.state === 'ok' ? `review ok (${r.reason})` : r.state === 'stale' ? `review stale (${r.why})` : r.state === 'not-needed' ? 'review not needed' : 'review none';
    lines.push(`selection ${s.selection.id}: ${s.selection.forThisCode ? 'this code' : 'other code (run --selection selects again)'} · ${review}`);
  }
  return lines;
}
