// @vitest-environment node
import { expect, it } from 'vitest';
import { entries, own } from '../../src/core/read.ts';
import { ENDPOINTS, parseAnswer } from '../../src/api/wire.ts';
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../../scripts/contract-fixture.mjs';
import { dashboardPagesCase } from '../support/dashboardFixture.ts';

const family = own(
  own(loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture, 'cases'),
  'profile_target',
);
const endpoints = [
  ENDPOINTS.config,
  ENDPOINTS.profileFiles,
  ENDPOINTS.profileSource,
  ENDPOINTS.profilePatch,
  ENDPOINTS.profileActivate,
];

it.each(entries(family).map(([name]) => name))(
  'PE1 PE2 profile_target.%s is registered on its wire endpoint',
  (name) => {
    const found = dashboardPagesCase(`profile_target.${name}`);
    const paths: Readonly<Record<string, string>> = {
      '/api/config': 'config',
      '/api/profile-files': 'profileFiles',
      '/api/profile-patch': 'profilePatch',
      '/api/profile-activate': 'profileActivate',
    };
    const endpoint = endpoints.find(
      (entry) =>
        entry.method === found.request.method &&
        (found.request.path.startsWith('/api/profile-src/')
          ? entry.id === 'profileSource'
          : paths[found.request.path] === entry.id),
    );
    if (endpoint === undefined) throw new Error(`unregistered ${found.request.path}`);
    expect(parseAnswer(endpoint, found.status, JSON.stringify(found.body)).contract).toBe('exact');
  },
);
