import { findApp, loadConfig } from '../config.mjs';
import { verify } from '../verify.mjs';
import { oneOf, parse, printUsage, UsageError } from './_args.mjs';

const OPTIONS = { app: { type: 'string' }, mode: { type: 'string' }, require: { type: 'string' }, 'max-age': { type: 'string' }, json: { type: 'boolean' } };

function ago(ts) {
  const min = Math.floor((Date.now() - Date.parse(ts)) / 60_000);
  if (!Number.isFinite(min)) return 'at an unknown time';
  if (min < 1) return 'just now';
  return min < 120 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

// The one line skills quote: verified (0), stale (20) with what moved and where to narrow from, insufficient (21).
// A selected run names the selection it ran, and whether it ran while trust=shadow (I4).
function line(res, { app, mode, require, maxAgeMin }) {
  if (res.status === 'verified') {
    const what = res.shards ? `shards×${res.shards.length}` : res.run.kind;
    const selection = res.run.kind === 'selected' && !res.shards ? ` (selection ${res.run.selectionId}${res.run.shadowed ? ', shadowed' : ''})` : '';
    return `verified: ${what}@${res.run.id}${selection} (${ago(res.run.ts)})`;
  }
  if (res.status === 'insufficient') {
    const wants = require === 'full' ? 'a full run or a complete shard set' : 'a full run, a complete shard set or a selected run from `run --selection`';
    return `insufficient: this code has only ${res.have.join('/')} run(s); --require ${require} needs ${wants}`;
  }
  if (res.expired) return `stale: ${res.expired.runId} passed this exact code ${res.expired.ageMin} min ago, older than --max-age ${maxAgeMin}`;
  const head = res.lastVerifiedHead;
  if (!head) {
    const dist = res.differing.length === 1 && res.differing[0] === 'dist' ? ' · dist: not built' : '';
    return `stale: nothing verified yet (no passing full run or shard set of app ${app.name} in ${mode} mode)${dist}`;
  }
  return `stale: no passing run for this code · differing: ${res.differing.join(',') || '-'} · last verified head ${head} · narrow with \`e2e-rail select --base ${head}\``;
}

export default async function verifyCommand(argv) {
  const { values, help } = parse(argv, OPTIONS);
  if (help) return printUsage('verify');
  const mode = values.mode === undefined ? 'dev' : oneOf(values.mode, ['dev', 'preview'], '--mode');
  const require = values.require === undefined ? 'full' : oneOf(values.require, ['full', 'selected'], '--require');
  let maxAgeMin = null;
  if (values['max-age'] !== undefined) {
    maxAgeMin = Number(values['max-age']);
    if (values['max-age'].trim() === '' || !Number.isFinite(maxAgeMin) || maxAgeMin < 0) throw new UsageError(`--max-age must be a number of minutes, got ${JSON.stringify(values['max-age'])}`);
  }
  const config = await loadConfig(process.cwd());
  const app = findApp(config, values.app);
  const res = verify({ config, app, mode, require, maxAgeMin });
  if (values.json) {
    console.log(JSON.stringify({
      status: res.status, exitCode: res.exitCode, app: app.name, mode, require,
      runId: res.run?.id ?? null, kind: res.run?.kind ?? null, selectionId: res.run?.selectionId ?? null,
      shadowed: res.run ? Boolean(res.run.shadowed) : null, shards: res.shards?.map((r) => r.id) ?? null,
      differing: res.differing ?? null, lastVerifiedHead: res.lastVerifiedHead ?? null, have: res.have ?? null,
      expired: res.expired ?? null, fingerprint: res.fingerprint,
    }, null, 2));
  } else console.log(line(res, { app, mode, require, maxAgeMin }));
  return res.exitCode;
}
