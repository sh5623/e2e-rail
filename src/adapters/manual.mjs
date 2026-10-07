import path from 'node:path';
import { normalizePattern } from './pattern.mjs';

// Fallback for frameworks without a parser: `adapter.map = { '<route>': ['src/…'] }` straight from the config.
export const manual = {
  name: 'manual',
  routeEntries({ app }) {
    const entries = [];
    const unresolved = [];
    for (const [raw, files] of Object.entries(app.adapter.map ?? {})) {
      if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
        unresolved.push(`manual map '${raw}': expected an array of file paths`);
        continue;
      }
      const route = normalizePattern(raw, app.adapter.basePath);
      for (const file of files) entries.push({ route, file: path.posix.normalize(file.replace(/\\/g, '/')) });
    }
    return { entries, unresolved };
  },
};
