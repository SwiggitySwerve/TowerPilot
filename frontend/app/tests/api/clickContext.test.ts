import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClickTimeContextRead } from '../../src/api/clickContext.ts';
import { contextFromConfig, expectedContext } from '../../src/api/context.ts';
import { ENDPOINTS } from '../../src/api/wire.ts';
import { dashboardPagesCase } from '../support/dashboardFixture.ts';
import { createFakeTransport } from '../support/fakeTransport.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it('r10 Profiles and Equipment click-time reads are fresh independent GETs, never an earlier in-flight read', async () => {
  const fake = createFakeTransport();
  const read = createClickTimeContextRead(fake.transport, ENDPOINTS.config);
  const earlier = read();
  const later = read();
  expect(fake.requests).toHaveLength(2);
  const original = dashboardPagesCase('loadout_patch.read_before_the_first_save');
  const other = dashboardPagesCase('config_state.effective_view_of_the_other_account');
  fake.last('/api/config').respond(other.status, other.body);
  expect(await later).toEqual(contextFromConfig(other.body));
  fake.next('/api/config').respond(original.status, original.body);
  expect(await earlier).toEqual(contextFromConfig(original.body));
  expect(vi.getTimerCount()).toBe(0);
});

it('r10 a click-time read times out after the shared five-second limit without sending a write', async () => {
  const fake = createFakeTransport();
  const reading = createClickTimeContextRead(fake.transport, ENDPOINTS.config)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await reading).toBeNull();
  expect(fake.next.bind(fake, '/api/config')).toThrow('no held request');
  expect(fake.writes()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('r10 a cancelled click-time read clears its timeout and cannot authorize a write', async () => {
  const fake = createFakeTransport();
  const controller = new AbortController();
  const reading = createClickTimeContextRead(fake.transport, ENDPOINTS.config)(controller.signal);
  controller.abort();
  expect(await reading).toBeNull();
  expect(fake.writes()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('r10 an unreadable config answer does not provide a click-time context', async () => {
  const fake = createFakeTransport();
  fake.route('GET', '/api/config', () =>
    dashboardPagesCase('config_state.file_missing_and_no_example_500'),
  );
  expect(await createClickTimeContextRead(fake.transport, ENDPOINTS.config)()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('r10 the shared mutation-context serializer emits exactly the four fields and preserves nulls', () => {
  const context = {
    instance: 'main',
    serial: 'fake:1',
    account: null,
    profile: null,
    extra: 'excluded',
  };
  expect(expectedContext(context)).toEqual({
    instance: 'main',
    account: null,
    profile: null,
    serial: 'fake:1',
  });
  expect(Object.keys(expectedContext(context)).sort()).toEqual([
    'account',
    'instance',
    'profile',
    'serial',
  ]);
});
