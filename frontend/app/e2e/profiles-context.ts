import fixture from './profiles-context-r10.json' with { type: 'json' };
import type { DashboardCase } from '../tests/support/dashboardFixture.ts';

/** Genuine Profiles refusal cases extracted unchanged from the r10 candidate; provenance is in JSON. */
export const profilesContextCases: readonly (readonly [string, DashboardCase])[] = Object.entries(
  fixture.cases.context_fence,
);

export function profilesContextCase(name: string): DashboardCase {
  const found = profilesContextCases.find(([key]) => key === name)?.[1];
  if (found === undefined) throw new Error(`Missing recorded Profiles context_fence case ${name}`);
  return structuredClone(found);
}
