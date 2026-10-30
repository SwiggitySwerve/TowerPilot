import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_PAGES_FIXTURE_PATH,
  loadJsonWithIdentity,
} from '../../../scripts/contract-fixture.mjs';
import { recognitionStatusAnswerSchema } from '../../../src/contract/recognition.ts';
import { own, ownPath } from '../../../src/core/read.ts';

describe('sealed scan metrics contract', () => {
  it('accepts the real status answer carrying its sealed metrics reference', () => {
    const fixture = loadJsonWithIdentity(DASHBOARD_PAGES_FIXTURE_PATH).fixture;
    const sample = ownPath(fixture, 'cases', 'scan_metrics', 'status_with_sealed_scan_metrics');
    expect(sample).toBeDefined();
    expect(
      recognitionStatusAnswerSchema.safeParse({
        status: own(sample, 'status'),
        body: own(sample, 'body'),
      }).success,
    ).toBe(true);
  });
});
