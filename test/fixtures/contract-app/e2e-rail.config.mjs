export default {
  apps: [{
    name: 'web', root: '.', playwrightConfig: 'playwright.config.ts',
    adapter: { name: 'manual', map: {} },
  }],
  ledger: { dir: '.e2e-rail' },
};
