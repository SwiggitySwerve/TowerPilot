import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Reporter, TestModule } from 'vitest/node';
import { capabilityFailures, proofFailures, WANTED_BASELINE } from './ledger.ts';
import { SAFETY_LEDGER } from './specData.ts';

/**
 * The ledgers' run-time gate (F1-01, spec 9 items 1 and 2): at the end of
 * every run it reads which tests PASSED per file, in this same run, and fails
 * the run when a file the safety ledger names has no passing test titled with
 * a rule id it is named for, or, in a run that includes
 * tests/spec/capabilityLedger.test.ts (every full run), when a Wanted-baseline
 * F-id has no passing test titled with it. Files that were not part of the run
 * (a partial run) are not judged here.
 */
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CAPABILITY_FILE = 'tests/spec/capabilityLedger.test.ts';

export default class LedgerReporter implements Reporter {
  onTestRunEnd(testModules: readonly TestModule[]): void {
    const passed = new Map<string, string[]>();
    for (const module of testModules) {
      const file = path.relative(APP, module.moduleId).split(path.sep).join('/');
      const titles = passed.get(file) ?? [];
      for (const test of module.children.allTests()) {
        if (test.result().state === 'passed') titles.push(test.name);
      }
      passed.set(file, titles);
    }
    const failures = proofFailures(SAFETY_LEDGER, (file) => passed.get(file));
    if (passed.has(CAPABILITY_FILE)) {
      failures.push(...capabilityFailures(WANTED_BASELINE, [...passed.values()].flat()));
    }
    if (failures.length > 0) {
      console.error(`\nLedgers: ${String(failures.length)} proof(s) missing in this run:`);
      for (const failure of failures) console.error(`  ${failure}`);
      process.exitCode = 1;
    }
  }
}
