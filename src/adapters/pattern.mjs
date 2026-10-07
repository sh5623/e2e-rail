import { normalizeRoute } from '../spec-index.mjs';

// normalizeRoute() cleans a URL a spec visits, so it cuts everything from the first `?` or `#`. In a router pattern
// `?` marks an optional segment (`:lang?/home`), so it is shielded while normalizeRoute strips basePath and slashes.
const SHIELD = { '?': '\u0001', '#': '\u0002' };
const UNSHIELD = { '\u0001': '?', '\u0002': '#' };

export function normalizePattern(raw, basePath) {
  const shielded = String(raw).replace(/[?#]/g, (c) => SHIELD[c]);
  return normalizeRoute(shielded, basePath).replace(/[\u0001\u0002]/g, (c) => UNSHIELD[c]);
}
