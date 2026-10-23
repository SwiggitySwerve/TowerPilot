import { loadJsonWithIdentity } from '../../scripts/contract-fixture.mjs';
import { R17B_SAMPLES_FILE } from '../../scripts/generate-contract.mjs';
import type { DashboardCase } from './dashboardFixture.ts';

/**
 * The r17b CANDIDATE action families (e2e/r17b-candidate-samples.json: battle_actions_projection,
 * action_executions, action_executions_more), copied unchanged from the candidate pages fixture
 * whose path and SHA-256 the file records. Addressed `<family>.<case>`; returned values are fresh
 * deep copies. Test-side only, like the other recorded samples.
 */
const LOADED = loadJsonWithIdentity(R17B_SAMPLES_FILE);
const CASES: unknown = Reflect.get(Object(LOADED.fixture), 'cases');

function familyOf(family: string): Readonly<Record<string, unknown>> {
  const found: unknown = Reflect.get(Object(CASES), family);
  if (typeof found !== 'object' || found === null)
    throw new Error(`The r17b candidate samples have no family ${family}`);
  return found as Readonly<Record<string, unknown>>;
}

/** The case names of a candidate family, sorted. */
export function r17bCaseNames(family: string): readonly string[] {
  return Object.keys(familyOf(family)).sort();
}

/** A deep copy of the candidate case `<family>.<case>`. */
export function r17bCase(path: string): DashboardCase {
  const [family = '', name = ''] = path.split('.');
  const found = familyOf(family)[name];
  if (typeof found !== 'object' || found === null)
    throw new Error(`The r17b candidate samples have no case ${path}`);
  return JSON.parse(JSON.stringify(found)) as DashboardCase;
}
