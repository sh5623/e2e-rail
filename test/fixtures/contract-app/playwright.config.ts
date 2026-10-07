// Two projects, no browser fixtures anywhere: the contract test needs the real runner, never a real browser.
export default {
  testDir: './e2e',
  projects: [{ name: 'chromium' }, { name: 'narrow', testMatch: ['**/b.spec.ts'] }],
};
