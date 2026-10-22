import path from 'node:path';
import { loadJsonWithIdentity } from '../../scripts/contract-fixture.mjs';
import type { DashboardCase } from './dashboardFixture.ts';

/** Verbatim r11 candidate cases, pending the backend landing (no reconstructed answers). */
const snapshot = loadJsonWithIdentity(path.resolve('e2e/r11-candidate-samples.json')).fixture as {
  cases: { collection_first_policy: Record<string, DashboardCase> };
};

export const firstPolicyCaseNames = Object.keys(snapshot.cases.collection_first_policy);

export function firstPolicyCase(name: string): DashboardCase {
  const found = snapshot.cases.collection_first_policy[name];
  if (found === undefined) throw new Error(`No recorded collection_first_policy.${name}`);
  return structuredClone(found);
}
