import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// e2e-rail ships no compiler of its own: it borrows the host's TypeScript.
// Lookup order: the app (and its ancestors) -> the directory the CLI runs from -> e2e-rail's own install.
export async function loadTypeScript(appDirAbs) {
  const candidates = [appDirAbs, process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const from of candidates) {
    try {
      return createRequire(path.join(from, 'package.json'))('typescript');
    } catch { /* try the next location */ }
  }
  throw new Error('typescript not found. Install it in the app (devDependency) — e2e-rail borrows the host compiler.');
}

export function readCompilerOptions(ts, appDirAbs, tsconfigRel) {
  const cfgPath = path.join(appDirAbs, tsconfigRel);
  const { config, error } = ts.readConfigFile(cfgPath, (p) => readFileSync(p, 'utf8'));
  if (error) throw new Error(`tsconfig: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(cfgPath), undefined, cfgPath);
  // A solution-style config (Vite's default: no files of its own, only `references`) carries no `paths`, so every
  // alias import would silently stop resolving. Refuse it and name the referenced configs instead.
  const refs = parsed.projectReferences ?? [];
  const noInputs = parsed.fileNames.length === 0 || parsed.errors.some((e) => e.code === 18002 || e.code === 18003);
  if (refs.length > 0 && noInputs && !parsed.options.paths) {
    const names = refs.map((r) => path.relative(appDirAbs, r.path).split(path.sep).join('/')).join(', ');
    throw new Error(`tsconfig ${tsconfigRel} is solution-style (no files of its own, only "references": ${names}) and has no compilerOptions.paths. Set the app's \`tsconfig\` to the referenced config that holds compilerOptions.paths (e.g. tsconfig.app.json).`);
  }
  return { options: parsed.options, fileNames: parsed.fileNames };
}

export function parseFile(ts, abs) {
  const kind = /\.[jt]sx$/.test(abs) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}
