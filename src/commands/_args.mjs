import path from 'node:path';
import { parseArgs } from 'node:util';

// One usage line per command. `e2e-rail --help` prints them all; the README and the skills quote them.
export const USAGES = {
  init: '[--force]',
  map: '[--app <name>] [--check] [--explain <spec>]',
  select: '[--app <name>] [--base <ref>] [--head <ref>] [--no-uncommitted] [--json]'
    + ' | [--app <name>] (--add <spec> | --remove <spec>)… --reason <text>',
  run: '[--app <name>] (--full | --selection [id] | --test-list <file> | --last-failed) [--mode dev|preview]'
    + ' [--workers N] [--project <name>] [--shard i/n] [--blob] [--no-lock] [--no-build] [-- <playwright args>]',
  verify: '[--app <name>] [--mode dev|preview] [--require full|selected] [--max-age <min>] [--json]',
  shadow: 'record --run <run-id> [--app <name>] | status | promote | demote',
  measure: '[--app <name>] slowest [-n N] | retries [--last N] | workers <1,2,4> --test-list <file> [--mode dev|preview]',
  shard: '[--app <name>] plan --count N [--from-run <run-id>] [--include <spec>]… [--mode dev|preview] | merge --dir <blob dir> [--mode dev|preview]',
  lock: 'status | reap | run <heavy|light> -- <command…>',
};

// Bad command-line input: printed with the command's usage line, exit 2.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function printUsage(name) {
  console.log(`usage: e2e-rail ${name} ${USAGES[name]}`);
  return 0;
}

const dashed = (k) => (k.length === 1 ? `-${k}` : `--${k}`);

// `node:util` parseArgs (`allowPositionals`, `strict: false`) with the checks strict mode would make, as usage errors:
// an unknown option, a string option without a value, a boolean option given a value. Everything after the first `--`
// is `passthrough`. parseArgs takes the next argument as a string option's value even when it is another option
// (`--selection --workers 1`), so a string option followed by an option or by nothing has no value here; an option
// declared `optionalValue: true` then reads as '' (`--selection` → the current selection), any other is an error.
// `-h`/`--help` is always accepted and returned as `help`.
export function parse(argv, options = {}, { maxPositionals = 0, passthrough: takesPassthrough = false } = {}) {
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  const spec = { help: { type: 'boolean', short: 'h' } };
  const optional = new Set();
  const byShort = new Map([['h', 'help']]);
  for (const [name, { optionalValue, ...o }] of Object.entries(options)) {
    spec[name] = o;
    if (optionalValue) optional.add(name);
    if (o.short) byShort.set(o.short, name);
  }
  const args = [];
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const name = /^--[^=]+$/.test(a) ? a.slice(2) : /^-[^-]$/.test(a) ? byShort.get(a[1]) : undefined;
    const bare = name !== undefined && Object.hasOwn(spec, name) && spec[name].type === 'string'
      && (i + 1 >= own.length || own[i + 1].startsWith('-'));
    if (!bare) args.push(a);
    else if (optional.has(name)) args.push(`--${name}=`);
    else throw new UsageError(`${a} needs a value`);
  }
  const { values, positionals } = parseArgs({ args, options: spec, allowPositionals: true, strict: false });
  for (const [k, v] of Object.entries(values)) {
    if (!Object.hasOwn(spec, k)) throw new UsageError(`unknown option ${dashed(k)}`);
    for (const x of Array.isArray(v) ? v : [v]) {
      if (spec[k].type === 'string' && typeof x !== 'string') throw new UsageError(`${dashed(k)} needs a value`);
      if (spec[k].type === 'boolean' && typeof x !== 'boolean') throw new UsageError(`${dashed(k)} takes no value`);
    }
  }
  const help = Boolean(values.help);
  if (!help && dd >= 0 && !takesPassthrough) throw new UsageError('this command takes no arguments after --');
  if (!help && positionals.length > maxPositionals) {
    throw new UsageError(`unexpected argument: ${positionals[maxPositionals]}${takesPassthrough ? ' (arguments for Playwright go after --)' : ''}`);
  }
  return { values, positionals, passthrough, help };
}

// A whole number ≥ 1 from an option value.
export function positiveInt(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`${flag} must be a whole number of 1 or more, got ${JSON.stringify(value)}`);
  return Number(value);
}

export function oneOf(value, allowed, flag) {
  if (!allowed.includes(value)) throw new UsageError(`${flag} must be ${allowed.join(' or ')}, got ${JSON.stringify(value)}`);
  return value;
}

// A path as the user sees it from the directory the CLI runs in.
export const shown = (abs) => path.relative(process.cwd(), abs) || '.';

export const ms = (n) => (n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

// Left-aligned columns; the keys of the first row are the header.
export function table(rows) {
  if (!rows.length) return '(none)';
  const keys = Object.keys(rows[0]);
  const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)));
  const line = (r) => keys.map((k, i) => String(r[k] ?? '').padEnd(width[i])).join('  ').trimEnd();
  return [line(Object.fromEntries(keys.map((k) => [k, k]))), ...rows.map(line)].join('\n');
}
