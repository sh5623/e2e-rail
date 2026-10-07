// Runs `runTests` in its own process: runTests hands the real Playwright our stdio, and its reporter output would
// otherwise land in the contract test's own report. Usage: node run-driver.mjs <root> <resultFile> <options JSON>
// (runTests options besides config and app, e.g. {"testList": "…", "workers": 1, "passthrough": ["-G", "x"]}).
import { writeFileSync } from 'node:fs';
import { loadConfig, findApp } from '../../src/config.mjs';
import { runTests } from '../../src/run.mjs';

const [root, resultFile, options = '{}'] = process.argv.slice(2);
const config = await loadConfig(root);
const { rc, entry } = await runTests({ config, app: findApp(config), ...JSON.parse(options) });
writeFileSync(resultFile, JSON.stringify({ rc, entry }));
