import path from 'node:path';
import { appDir, findApp, loadConfig } from '../config.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { affectedEntries, findMain, loadOrBuildGraph } from '../graph.mjs';
import { loadOrBuildSpecIndex } from '../spec-index.mjs';
import { matchAny, walk } from '../util/glob.mjs';
import { loadTypeScript } from '../util/ts.mjs';
import { parse, printUsage } from './_args.mjs';

const OPTIONS = { app: { type: 'string' }, check: { type: 'boolean' }, explain: { type: 'string' } };

// A spec as the index keys it (app-relative); a repo-relative path under the app root is accepted too.
function specKey(app, raw) {
  const rel = path.posix.normalize(raw.split(path.sep).join('/')).replace(/^\.\//, '');
  const root = path.posix.normalize(app.root).replace(/\/$/, '');
  return root !== '.' && rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel;
}

async function explain(config, app, raw) {
  const ts = await loadTypeScript(appDir(config, app));
  const index = await loadOrBuildSpecIndex({ config, app, ts });
  const spec = specKey(app, raw);
  if (!Object.hasOwn(index.specs, spec)) {
    throw new Error(`${spec} is not in the spec index of app ${app.name} (${Object.keys(index.specs).length} specs; paths are app-relative, e.g. ${Object.keys(index.specs)[0] ?? 'e2e/x.spec.ts'})`);
  }
  console.log(JSON.stringify({ app: app.name, spec, ...index.specs[spec] }, null, 2));
  return 0;
}

// Would any src change of this app narrow, and if not, why. It asks the selector's own question for each route entry
// file: does a change to that page reach only route entries (narrow) or also main / nothing (the app runs in full)?
function verdict({ app, graph, entries, unresolved, main, boundary }) {
  const full = (why) => `every src change will run full: ${why}`;
  if (unresolved.length) return full(`the ${app.adapter.name} adapter could not read ${unresolved.length} route definition(s) (the ! lines above)`);
  if (graph.missing.length) return full(`${graph.missing.length} internal import(s) do not resolve, so no import edge can be trusted (check tsconfig paths)`);
  if (!main) return full(`no app entry (${app.srcDir}/main.* or index.*) was found; set app.main`);
  if (!Object.hasOwn(graph.reverse, main)) return full(`the app entry ${main} is not in the import graph of ${app.srcDir}`);
  const files = [...new Set(entries.map((e) => e.file))];
  if (!files.length) return full(`the ${app.adapter.name} adapter found no route entries${app.adapter.routeFiles.length ? '' : ' (adapter.routeFiles is empty)'}`);
  let narrow = 0;
  let shell = 0;
  for (const f of files) {
    const r = affectedEntries(graph, [f], files, main, boundary);
    if (r.shell.length) shell += 1;
    else if (!r.unresolved.length) narrow += 1;
  }
  if (narrow) return `narrowing possible (${narrow} of ${files.length} route entry files can be selected on their own)`;
  if (shell) {
    const hint = app.adapter.routeFiles.length ? '' : '; adapter.routeFiles is empty, so the climb from a page passes the route table up to main (list the route table files there)';
    return full(`every route entry file reaches ${main} through its importers${hint}`);
  }
  return full(`no route entry file is part of the import graph (e.g. ${files[0]})`);
}

async function mapApp(config, app, check) {
  const dirAbs = appDir(config, app);
  const ts = await loadTypeScript(dirAbs);
  const index = await loadOrBuildSpecIndex({ config, app, ts });
  const specs = Object.entries(index.specs);
  const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts });
  console.log(`app ${app.name}: ${specs.length} specs indexed · ${entries.length} route entries · adapter unresolved ${unresolved.length}`);
  for (const u of unresolved) console.log(`  ! ${u}`);
  if (!check) return;
  // Test files Playwright lists outside specDir are indexed unmapped (never read), and the index cache does not see them
  // change: specDir should be where Playwright looks.
  const specDir = path.posix.normalize(app.specDir).replace(/\/+$/, '');
  const outside = specs.map(([f]) => f).filter((f) => specDir !== '.' && !f.startsWith(`${specDir}/`));
  if (outside.length) {
    console.log(`  warning: ${outside.length} tests outside specDir — set specDir to Playwright rootDir \`${index.rootDir || '.'}\``);
    for (const f of outside.slice(0, 5)) console.log(`    outside: ${f}`);
    if (outside.length > 5) console.log(`    … and ${outside.length - 5} more`);
  }
  const graph = await loadOrBuildGraph({ config, app, ts });
  const main = findMain(config, app);
  console.log(`  graph: ${graph.files.length} files · missing ${graph.missing.length} · opaque ${graph.opaque.length} · main ${main ?? 'none'}`);
  for (const m of graph.missing.slice(0, 5)) console.log(`    missing: ${m.from} → ${m.spec}`);
  if (graph.missing.length > 5) console.log(`    … and ${graph.missing.length - 5} more`);
  const boundary = walk(dirAbs).filter((rel) => matchAny(app.adapter.routeFiles, rel));
  console.log(`  verdict: ${verdict({ app, graph, entries, unresolved, main, boundary })}`);
  const unmapped = specs.filter(([, s]) => s.unmapped).map(([f]) => f);
  const pct = specs.length ? Math.round((unmapped.length / specs.length) * 100) : 0;
  console.log(`  unmapped: ${unmapped.length}/${specs.length} (${pct}%) — these run on every src change`);
  for (const f of unmapped) console.log(`    - ${f}`);
}

// (Re)builds the spec index of each app (every app unless --app); --check adds the selector's view of the app.
export default async function map(argv) {
  const { values, help } = parse(argv, OPTIONS);
  if (help) return printUsage('map');
  const config = await loadConfig(process.cwd());
  if (values.explain !== undefined) return explain(config, findApp(config, values.app), values.explain);
  const apps = values.app ? [findApp(config, values.app)] : config.apps;
  let rc = 0;
  for (const app of apps) {
    try {
      await mapApp(config, app, values.check);
    } catch (error) {
      console.error(`e2e-rail: app ${app.name}: ${String(error?.message ?? error).replace(/^e2e-rail: /, '')}`);
      rc = 1;
    }
  }
  if (!values.app) console.log(`covered apps: ${apps.map((a) => a.name).join(', ')}`);
  return rc;
}
