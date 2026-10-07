import { randomBytes } from 'node:crypto';

// `<prefix>-YYYYMMDD-HHMMSS-<4 hex>` (UTC): sortable by time, unique enough for one repo's ledger.
export function newId(prefix, now = new Date()) {
  const iso = now.toISOString(); // 2026-10-07T15:30:12.345Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${prefix}-${stamp}-${randomBytes(2).toString('hex')}`;
}
