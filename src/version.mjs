import { createRequire } from 'node:module';

// This copy's version (package.json): `--version`, `status`, and the review record a selection carries.
export const VERSION = createRequire(import.meta.url)('../package.json').version;
