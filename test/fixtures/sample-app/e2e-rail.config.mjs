export default {
  apps: [{
    name: 'web', root: '.', playwrightConfig: 'playwright.config.ts',
    specDir: 'e2e', supportDirs: ['e2e/support'], srcDir: 'src', tsconfig: 'tsconfig.json',
    adapter: { name: 'react-router-lazy', routeFiles: ['src/features/*/routes.ts', 'src/router.ts'], basePath: '/app' },
    apiPrefix: '/api', alwaysRun: ['smoke'],
    tiers: { full: ['src/main.ts', 'src/router.ts', 'src/shell/**'], ignore: ['**/*.test.ts'] },
    run: { port: 5999, preview: { build: 'node build.mjs', dist: 'dist' }, workers: { local: 2, ci: 1 }, modeEnv: { preview: { E2E_PREVIEW: '1' } } },
  }],
  shared: ['packages/**'], ignore: ['**/*.md', 'docs/**'],
  shadow: { promoteAfter: 2 }, ledger: { dir: '.e2e-rail' },
};
