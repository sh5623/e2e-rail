import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGES } from '../src/commands/_args.mjs';
import { assertPassthrough } from '../src/run.mjs';
import { MIN_PLAYWRIGHT } from '../src/util/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = ['init', 'select', 'gate', 'measure', 'shadow'];
const CI = ['templates/ci/github-actions-shard.yml', 'templates/ci/codebuild-batch.yml', 'templates/ci/buildspec-snippet.yml'];
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const sync = () => execFileSync('node', [path.join(root, 'scripts/sync-codex.mjs')], { encoding: 'utf8' });

// Every file below `rel` as { 'a/b.md': '<content>' } (POSIX paths relative to `rel`).
function tree(rel) {
  const out = {};
  const walk = (abs, prefix) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const sub = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(abs, ent.name), sub);
      else out[sub] = readFileSync(path.join(abs, ent.name), 'utf8');
    }
  };
  walk(path.join(root, rel), '');
  return out;
}

// ── brief ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('every skill has frontmatter with name/description and calls the CLI via pnpm exec', () => {
  for (const s of SKILLS) {
    const md = readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: `), s);
    assert.match(md, /pnpm exec e2e-rail|npx e2e-rail/, s);
  }
  assert.match(readFileSync(path.join(root, 'skills/gate/SKILL.md'), 'utf8'), /--last-failed[\s\S]*never/i);
});

// Before anything syncs: the mirror as committed must already match, or a stale Codex package would ship.
test('the committed Codex mirror already equals the root skills, references and doctrine (run `npm run sync:codex`)', () => {
  assert.deepEqual(tree('plugins/e2e-rail/skills'), tree('skills'));
  assert.deepEqual(tree('plugins/e2e-rail/references'), tree('references'));
  assert.equal(read('plugins/e2e-rail/hooks/doctrine.md'), read('hooks/doctrine.md'));
});

test('codex package mirrors root skills, doctrine and references exactly', () => {
  execFileSync('node', [path.join(root, 'scripts/sync-codex.mjs')]);
  for (const s of SKILLS) assert.equal(readFileSync(path.join(root, 'plugins/e2e-rail/skills', s, 'SKILL.md'), 'utf8'), readFileSync(path.join(root, 'skills', s, 'SKILL.md'), 'utf8'));
  assert.equal(readFileSync(path.join(root, 'plugins/e2e-rail/hooks/doctrine.md'), 'utf8'), readFileSync(path.join(root, 'hooks/doctrine.md'), 'utf8'));
  assert.equal(readFileSync(path.join(root, 'plugins/e2e-rail/references/impact-analyst.md'), 'utf8'), readFileSync(path.join(root, 'references/impact-analyst.md'), 'utf8'));
  const codex = JSON.parse(readFileSync(path.join(root, 'plugins/e2e-rail/.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(codex.name, 'e2e-rail'); assert.equal(codex.skills, './skills/');
  const mk = JSON.parse(readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(mk.plugins[0].source.path, './plugins/e2e-rail');
});

test('hooks.json runs doctrine on SessionStart; doctrine is short', () => {
  const h = JSON.parse(readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
  assert.match(h.hooks.SessionStart[0].hooks[0].command, /doctrine\.md/);
  assert.ok(readFileSync(path.join(root, 'hooks/doctrine.md'), 'utf8').split('\n').filter(Boolean).length <= 12);
  for (const f of ['templates/ci/github-actions-shard.yml', 'templates/ci/codebuild-batch.yml', 'templates/ci/buildspec-snippet.yml', 'README.md', 'README.ko.md', 'CHANGELOG.md']) assert.ok(existsSync(path.join(root, f)), f);
});

// ── Codex package and plugin manifests ─────────────────────────────────────────────────────────────────────────────

test('sync-codex is idempotent, mirrors deletions and leaves only the package files', () => {
  const staleSkill = path.join(root, 'plugins/e2e-rail/skills/zz-stale');
  const staleRef = path.join(root, 'plugins/e2e-rail/references/zz-stale.md');
  try {
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(path.join(staleSkill, 'SKILL.md'), 'stale\n');
    writeFileSync(staleRef, 'stale\n');
    sync();
    const once = tree('plugins/e2e-rail');
    sync();
    assert.deepEqual(tree('plugins/e2e-rail'), once);
    assert.ok(!existsSync(staleSkill) && !existsSync(staleRef), 'files gone from the root copies are removed from the mirror');
    assert.deepEqual(Object.keys(once).sort(), [
      '.codex-plugin/plugin.json', 'hooks/doctrine.md', 'hooks/hooks.json', 'references/impact-analyst.md',
      ...SKILLS.map((s) => `skills/${s}/SKILL.md`),
    ].sort());
  } finally {
    rmSync(staleSkill, { recursive: true, force: true });
    rmSync(staleRef, { force: true });
  }
});

test('hook commands: Claude reads ${CLAUDE_PLUGIN_ROOT}, Codex reads $PLUGIN_ROOT', () => {
  const claude = JSON.parse(read('hooks/hooks.json')).hooks.SessionStart[0].hooks[0];
  const codex = JSON.parse(read('plugins/e2e-rail/hooks/hooks.json')).hooks.SessionStart[0].hooks[0];
  assert.equal(claude.command, 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/doctrine.md"');
  assert.equal(codex.command, 'cat "$PLUGIN_ROOT/hooks/doctrine.md"');
  assert.equal(claude.type, 'command'); assert.equal(codex.type, 'command');
});

test('package.json, the Claude plugin and the Codex plugin carry one version', () => {
  const v = JSON.parse(read('package.json')).version;
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, v);
  assert.equal(JSON.parse(read('plugins/e2e-rail/.codex-plugin/plugin.json')).version, v);
});

test('D: the Playwright floor is one number: peerDependencies, the runtime check, the READMEs, the init skill and the CI contract matrix', () => {
  const floor = MIN_PLAYWRIGHT.split('.').slice(0, 2).join('.');
  const esc = (s) => s.replace(/[.]/g, '\\.');
  assert.equal(JSON.parse(read('package.json')).peerDependencies['@playwright/test'], `>=${floor}`);
  assert.match(read('README.md'), new RegExp(`\`@playwright/test\` ≥ ${esc(floor)}`));
  assert.match(read('README.ko.md'), new RegExp(`\`@playwright/test\` ≥ ${esc(floor)}`));
  assert.match(read('skills/init/SKILL.md'), new RegExp(`\`@playwright/test\` ${esc(floor)} or newer`));
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, new RegExp(`playwright: "${esc(MIN_PLAYWRIGHT)}"`), 'a contract job on the minimum');
  assert.match(ci, /npm i --no-save @playwright\/test@\$\{\{ matrix\.playwright \}\}/);
  assert.match(ci, /run: npm run test:contract/);
});

// ── skills, agent, doctrine ────────────────────────────────────────────────────────────────────────────────────────

test('skills: trigger-rich description, short body', () => {
  for (const s of SKILLS) {
    const md = read(`skills/${s}/SKILL.md`);
    const description = /^description: (.+)$/m.exec(md)?.[1] ?? '';
    assert.match(description, /Use when/, s);
    assert.match(description, /Do NOT load for/, s);
    assert.ok(md.split('\n').length <= 120, `${s}: ${md.split('\n').length} lines`);
  }
});

test('gate: verify in the run mode, fixed report tokens, shadowed and filtered runs never reported as full', () => {
  const md = read('skills/gate/SKILL.md');
  assert.match(md, /pnpm exec e2e-rail verify --app <app> --mode <mode> --require full/);
  for (const token of ['run-id', 'kind full (filtered)', 'shadowed:', 'nothing selected (partial, 0 specs)', 'verified:', 'stale:', 'insufficient:']) {
    assert.ok(md.includes(token), token);
  }
});

test('select: the selection block carries change, selected, added/removed, mobile, unmapped and final', () => {
  const md = read('skills/select/SKILL.md');
  for (const field of ['change:', 'selected:', 'added:', 'removed:', 'mobile:', 'unmapped:', 'final:']) assert.ok(md.includes(field), field);
  assert.match(md, /e2e-impact-analyst/);
  assert.match(md, /references\/impact-analyst\.md/);
});

test('impact analyst: READ-ONLY agent whose body is the Codex reference, additions only', () => {
  const md = read('agents/e2e-impact-analyst.md');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(fm, 'frontmatter');
  assert.match(fm[1], /^name: e2e-impact-analyst$/m);
  assert.match(fm[1], /^description: READ-ONLY\./m);
  assert.match(fm[1], /^tools: Read, Grep, Glob, Bash$/m);
  assert.equal(md.slice(fm[0].length), read('references/impact-analyst.md'));
  assert.match(md, /- add e2e\/<spec>\.spec\.ts — <reason>/);
  assert.match(md, /never propose[\s\S]{0,40}remov/i);
});

// ── docs and templates name only what the CLI accepts ──────────────────────────────────────────────────────────────

const NAMES = Object.keys(USAGES);
const SUBS = { shadow: ['record', 'status', 'promote', 'demote'], measure: ['slowest', 'retries', 'workers'], shard: ['plan', 'merge'], lock: ['status', 'reap', 'run'] };
const flagsIn = (s) => new Set(s.match(/(?<![\w-])(?:--[a-z][a-z0-9-]*|-[a-z])(?![\w-])/gi) ?? []);
const wordRe = (w) => new RegExp(`(^|[\\s(\\[])${w}(?=[\\s)\\]]|$)`);

// The options `e2e-rail <cmd> [sub]` takes, read from the usage lines `--help` prints. A subcommand takes the options
// of its own usage alternative plus those written before the first subcommand (`[--app <name>] slowest …`).
function accepted(cmd, sub) {
  const out = new Set(['--help', '-h']);
  const usage = USAGES[cmd];
  if (!SUBS[cmd]) { for (const f of flagsIn(usage)) out.add(f); return out; }
  const alts = usage.split(' | ');
  const first = SUBS[cmd].find((w) => wordRe(w).test(alts[0]));
  for (const f of flagsIn(alts[0].slice(0, alts[0].search(wordRe(first))))) out.add(f);
  for (const alt of alts) if (sub === undefined || wordRe(sub).test(alt)) for (const f of flagsIn(alt)) out.add(f);
  return out;
}

// Code in a document: every line of a template, fenced lines and inline `code` spans of Markdown.
function codeSegments(rel, text) {
  if (rel.endsWith('.yml')) return text.split('\n');
  const segs = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) segs.push(line);
    else for (const m of line.matchAll(/`([^`]+)`/g)) segs.push(m[1]);
  }
  return segs;
}

const INVOKE = /(?:^\s*|pnpm exec\s+|npx\s+|["'(]|\$\s+)e2e-rail\s+(\S+)/g;
const STOP = /\s(?:\||;|&&|\|\||#)\s|[;`)]|\s#|\se2e-rail\s/;

// `e2e-rail <cmd> <args>` → { cmd, sub, own, passthrough }; also a code span that starts with a command name
// (`select --add …`, `shard plan --count N`).
function invocationsIn(seg) {
  const found = [];
  const take = (cmd, raw) => {
    const rest = raw.replace(/\$\([^)]*\)/g, ''); // `--base $(cat …)`: the shell's part, not e2e-rail's
    const cut = rest.search(STOP);
    const args = cut >= 0 ? rest.slice(0, cut) : rest;
    const dd = args.search(/(^|\s)--(\s|$)/);
    const own = dd >= 0 ? args.slice(0, dd) : args;
    const passthrough = dd >= 0 ? args.slice(dd).replace(/^\s*--\s*/, '').split(/\s+/).filter(Boolean) : [];
    const sub = SUBS[cmd]?.find((w) => own.split(/\s+/).includes(w));
    found.push({ cmd, sub, own, passthrough, text: `${cmd}${rest}`.trim() });
  };
  for (const m of seg.matchAll(INVOKE)) take(m[1], seg.slice(m.index + m[0].length));
  const bare = /^\s*([a-z]+)\s+(.*)$/.exec(seg);
  if (bare && NAMES.includes(bare[1]) && !/e2e-rail\s/.test(seg) && /(^|\s)-{1,2}[a-z]|\b(record|status|promote|demote|slowest|retries|workers|plan|merge|reap)\b/.test(bare[2])) {
    take(bare[1], ` ${bare[2]}`);
  }
  return found;
}

const DOCS = [
  ...SKILLS.map((s) => `skills/${s}/SKILL.md`), 'agents/e2e-impact-analyst.md', 'references/impact-analyst.md',
  'hooks/doctrine.md', 'README.md', 'README.ko.md', 'CHANGELOG.md', ...CI,
];

test('every e2e-rail command in the skills, agent, doctrine, READMEs and CI templates uses only flags the CLI accepts', () => {
  const problems = [];
  let checked = 0;
  for (const rel of DOCS) {
    for (const seg of codeSegments(rel, read(rel))) {
      for (const inv of invocationsIn(seg)) {
        // `e2e-rail --version`, and placeholders such as `e2e-rail <command> --help` or `e2e-rail …`
        if (/^--?(version|help|v|h)$/.test(inv.cmd) || /^[^a-z-]/.test(inv.cmd)) continue;
        if (!NAMES.includes(inv.cmd)) { problems.push(`${rel}: unknown command \`e2e-rail ${inv.cmd}\``); continue; }
        checked += 1;
        const ok = accepted(inv.cmd, inv.sub);
        for (const f of flagsIn(inv.own)) if (!ok.has(f)) problems.push(`${rel}: \`${inv.text}\` — ${f} is not an option of ${inv.cmd}${inv.sub ? ` ${inv.sub}` : ''}`);
        if (inv.passthrough.length && inv.cmd !== 'run' && inv.cmd !== 'lock') problems.push(`${rel}: \`${inv.text}\` — ${inv.cmd} takes no arguments after --`);
        if (inv.cmd === 'run' && inv.passthrough.length) {
          try { assertPassthrough(inv.passthrough); } catch (e) { problems.push(`${rel}: \`${inv.text}\` — ${e.message}`); }
        }
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 60, `only ${checked} commands found; is the parser still reading the docs?`);
});

test('command tables in the READMEs list only options of the command in their first cell', () => {
  const problems = [];
  for (const rel of ['README.md', 'README.ko.md']) {
    for (const line of read(rel).split('\n')) {
      const m = /^\|\s*`([a-z]+)(?: ([a-z]+))?`\s*\|/.exec(line);
      if (!m || !NAMES.includes(m[1])) continue;
      const ok = accepted(m[1], m[2]);
      for (const span of line.matchAll(/`([^`]+)`/g)) {
        const own = span[1].split(/(?:^|\s)--(?:\s|$)/)[0];
        for (const f of flagsIn(own)) if (!ok.has(f)) problems.push(`${rel}: ${m[1]} row names ${f}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the flag checker itself rejects an unknown flag, a wrong subcommand flag and a refused passthrough', () => {
  const [a] = invocationsIn('pnpm exec e2e-rail run --app web --full --nope');
  assert.ok(!accepted(a.cmd, a.sub).has('--nope'));
  const [b] = invocationsIn('pnpm exec e2e-rail shard plan --dir x');
  assert.equal(b.sub, 'plan');
  assert.ok(!accepted(b.cmd, b.sub).has('--dir'));
  const [c] = invocationsIn('pnpm exec e2e-rail run --full -- --last-failed');
  assert.throws(() => assertPassthrough(c.passthrough));
  const [d] = invocationsIn('select --add e2e/a.spec.ts --reason "x"');
  assert.equal(d.cmd, 'select');
  assert.ok(accepted('measure', 'slowest').has('-n') && accepted('measure', 'slowest').has('--app'));
  assert.ok(!accepted('measure', 'slowest').has('--test-list'));
});

// ── CI templates and READMEs ───────────────────────────────────────────────────────────────────────────────────────

test('CI templates are YAML-shaped: no tabs, even indentation, the expected anchors', () => {
  for (const rel of CI) {
    const text = read(rel);
    assert.ok(!text.includes('\t'), `${rel}: tab`);
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      assert.equal((line.length - line.trimStart().length) % 2, 0, `${rel}:${i + 1}: odd indentation`);
      assert.ok(!/\s$/.test(line), `${rel}:${i + 1}: trailing whitespace`);
    });
  }
  const gh = read(CI[0]);
  assert.match(gh, /^jobs:$/m);
  assert.match(gh, /e2e-rail run --app "\$E2E_APP" --full --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ env\.E2E_SHARDS \}\} --blob --mode preview/);
  assert.match(gh, /e2e-rail shard merge --app "\$E2E_APP" --dir /);
  assert.match(gh, /^#.*e2e-rail shard plan --app "\$E2E_APP" --count/m, 'commented planned-shards variant');
  assert.match(gh, /^#.*--test-list "\.e2e-rail\/shards\/\$E2E_APP\/\$\{\{ matrix\.shard \}\}\.txt" --shard/m);
  const cb = read(CI[1]);
  assert.match(cb, /^batch:$/m);
  assert.match(cb, /build-graph:/);
  assert.match(cb, /e2e-rail run --app "\$E2E_APP" --full --shard "\$E2E_SHARD\/\$E2E_SHARDS" --blob --mode preview/);
  const snippet = read(CI[2]);
  assert.match(snippet, /e2e-rail run --app "\$E2E_APP" --full --mode preview/);
  assert.match(snippet, /e2e-rail shadow record --app "\$E2E_APP" --run "\$run_id"/);
  assert.match(snippet, /run_id=\$\(sed -n 's\/\^run-id/);
});

test('README.ko.md follows README.md section by section; Limits names the known gaps', () => {
  const en = read('README.md');
  const ko = read('README.ko.md');
  const count = (t, re) => (t.match(re) ?? []).length;
  assert.equal(count(ko, /^## /gm), count(en, /^## /gm), '## sections');
  assert.equal(count(ko, /^```/gm), count(en, /^```/gm), 'fences');
  assert.match(ko, /[가-힣]/);
  for (const gap of ['import.meta.glob', 'resolve.alias', 'errorElement', '.env.local', 'tiers.full', 'impact-analyst', 'shadow']) {
    assert.ok(en.includes(gap), `README.md limits: ${gap}`);
    assert.ok(ko.includes(gap), `README.ko.md limits: ${gap}`);
  }
  assert.match(read('CHANGELOG.md'), /^## 0\.1\.0 — /m);
});
