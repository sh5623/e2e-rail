import { reactRouterLazy } from './react-router-lazy.mjs';
import { manual } from './manual.mjs';

// An adapter turns the app's routing into `{ entries: [{ route, file }], unresolved: [reason] }` (spec §5).
// `file` is app-relative POSIX, `route` is basePath-stripped. Whatever an adapter cannot read goes to `unresolved`:
// the selector widens to a full run on any of them, so an adapter must never drop a route silently.
const REGISTRY = { [reactRouterLazy.name]: reactRouterLazy, [manual.name]: manual };

export function getAdapter(name) {
  const adapter = REGISTRY[name];
  if (!adapter) throw new Error(`unknown adapter: ${name}`);
  return adapter;
}

export const adapterNames = () => Object.keys(REGISTRY);
