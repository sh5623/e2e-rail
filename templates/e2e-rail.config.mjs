// e2e-rail configuration. Keep this file at the repository root.
// A monorepo lists one entry per app in `apps`; a single-app repo keeps one.
// Every path below is relative to the app root unless noted otherwise.
// Each app needs @playwright/test 1.56 or newer (selected and shard runs use --test-list; an older one is refused).
export default {
  apps: [
    {
      name: '__APP_NAME__',
      root: '__APP_ROOT__',                    // directory holding the Playwright config, specs and src
      playwrightConfig: '__PW_CONFIG__',       // relative to `root`; must exist

      specDir: 'e2e',
      supportDirs: ['e2e/support'],            // helpers the specs import; a change here selects the whole app
      srcDir: 'src',
      tsconfig: 'tsconfig.json',               // resolves `paths` aliases (for example "@/*") when tracing imports

      // How a source file maps to a URL. Pick one adapter:
      //   'react-router-lazy' - reads route files for `path` + lazy `import()` pairs
      //   'manual'            - you write the file -> routes map yourself (see `map`)
      adapter: {
        name: 'react-router-lazy',
        routeFiles: ['src/**/routes.ts', 'src/**/routes.tsx', 'src/router.ts', 'src/router.tsx'],
        basePath: '',                          // prefix the router adds in front of every route path
        // map: { 'src/pages/Home.tsx': ['/'] },   // used by the 'manual' adapter
      },

      apiPrefix: '/api',                       // URL prefix of backend calls (matched against the requests specs mock with `route()`)
      alwaysRun: [],                           // spec slugs (file name without extension) kept in every selection, e.g. ['smoke']

      tiers: {
        // Touching any of these runs the app's whole suite. Support dirs, the Playwright config and
        // package.json are always included; list app entry points and shared shell code here, e.g.
        //   'src/main.tsx', 'src/routes/**', 'src/lib/auth/**', 'src/styles/**', 'index.html'
        full: [],
        // Never trigger a run: unit tests next to the source (under srcDir only — Playwright also runs `*.test.ts`,
        // and a test file under specDir is never ignored) and Markdown.
        ignore: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx', '**/*.md'],
      },

      run: {
        // port: 5173,                         // dev/preview server port, when the repo needs one
        // preview: { build: 'npm run build', dist: 'dist' },   // build command + output dir for preview mode
        // workers: { local: 4, ci: 1 },       // measured values; `e2e-rail measure workers` proposes them
        // Environment per run mode. The plugin injects nothing by itself: declare what your repo expects.
        // modeEnv: { preview: { MY_PREVIEW_FLAG: '1' } },
        // env: {},                            // extra environment applied to every run
      },
    },
  ],

  shared: ['packages/**', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'tsconfig*.json'],   // repo-root paths; a change selects every app
  ignore: ['**/*.md', 'docs/**'],              // changes that never affect any test
  shadow: { promoteAfter: 3 },                 // promote selection to the gate after N consecutive runs where failures were a subset of it
  ledger: { dir: '.e2e-rail' },                // run history; add it to .gitignore
};
