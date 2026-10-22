import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandView } from '../../src/core/commands.ts';
import { own, ownPath } from '../../src/core/read.ts';
import { answeredBody } from '../../src/store/reads.ts';
import { selectOutcomes } from '../../src/store/selectors/outcomes.ts';
import { selectReadPlan } from '../../src/store/selectors/readPlan.ts';
import { bootDashboard, flush, fence } from '../support/dataLayer.ts';
import { dashboardBody, dashboardCase } from '../support/dashboardFixture.ts';
import { sample, statusBody } from '../support/fixture.ts';

/**
 * The wired data layer (app/wiring.ts) with the fake transport of OD-8,
 * including the cases the backend cannot produce (dashboard contract report,
 * `cannot_produce`): the dropped clear_flag answer and the overlapping read of
 * /api/battles/active.
 */
beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('fake-transport cases the backend cannot produce', () => {
  it('a dropped clear_flag answer stays unconfirmed, is never resent, and a later stop_flag is only the current state', async () => {
    const listed = dashboardBody('status.stop_flag_true_with_a_listed_run') as Record<
      string,
      unknown
    >;
    let body: unknown = {
      ...listed,
      ...statusBody(sample('status.off'), { processes: listed['processes'] }),
    };
    const { fake, data } = bootDashboard({ status: () => body });
    await flush();
    await data.commands.clearFlag({ ...fence(data), operationId: 'op-run', expectedRevision: 2 });
    expect(fake.writes().map((entry) => JSON.parse(entry.body ?? '{}') as unknown)).toEqual([
      { action: 'clear_flag', operation_id: 'op-run', expected_revision: 2 },
    ]);
    // The flag file is removed on the server, then the answer never arrives at all.
    fake.last('/api/control').lose();
    const cleared = dashboardBody(
      'status.stop_flag_false_after_the_lost_clear_flag_answer',
    ) as Record<string, unknown>;
    body = { ...cleared, ...statusBody(sample('status.off'), { processes: cleared['processes'] }) };
    await vi.advanceTimersByTimeAsync(60_000);
    const line = selectOutcomes(data.store.getSnapshot()).lines[0];
    expect(line).toMatchObject({
      kind: 'clear_flag',
      phase: 'unconfirmed',
      lost: 'network',
      settledByRead: null,
      resendOffered: false,
    });
    expect(own(answeredBody(data.store.getSnapshot(), 'status'), 'stop_flag')).toBe(false);
    expect(data.machine.resend(line?.id ?? '')).toBe('not_resendable');
    expect(fake.writes()).toHaveLength(1);
    data.stop();
  });

  it('an overlapping /api/battles/active read (row before the close, commands after) settles a Run now as recorded, never as done, and sends nothing', async () => {
    const active = dashboardCase('battles_active.commands_controls_requested_action_requested')
      .body as Record<string, unknown>;
    const battle = active['battle'] as Record<string, unknown>;
    const { fake, data } = bootDashboard({
      before: (transport) => {
        transport.route('GET', '/api/battles/active', () => ({ status: 200, body: active }));
      },
    });
    await flush();
    await data.commands.runNow({
      ...fence(data),
      operationId: String(battle['operation_id']),
      battleId: String(battle['id']),
      generation: String(battle['generation']),
      expectedRevision: 0,
      action: 'ad_gems',
    });
    const sent = JSON.parse(fake.writes()[0]?.body ?? '{}') as Record<string, unknown>;
    fake.last(/\/actions$/).respond(500, '<!doctype html>');
    await flush();
    // The overlapping read: the row still active, its commands already expired by the close,
    // one of them carrying this request's key.
    const recorded = (battle['commands'] as Record<string, unknown>[]).find(
      (entry) => entry['kind'] === 'action',
    );
    const overlapping = {
      ...active,
      battle: {
        ...battle,
        commands: [
          {
            ...recorded,
            state: 'expired',
            reason: 'battle_ended',
            request_keys: [sent['idempotency_key']],
          },
        ],
      },
    };
    fake.route('GET', '/api/battles/active', () => ({ status: 200, body: overlapping }));
    await vi.advanceTimersByTimeAsync(3000);
    const line = selectOutcomes(data.store.getSnapshot()).lines[0];
    // Answered unknown (500): no answer can still arrive, so the read resolves the record.
    expect(line).toMatchObject({ kind: 'run_now', phase: 'confirmed', resendOffered: false });
    expect(line?.settledByRead).toBe('recorded');
    const command = ownPath(overlapping, 'battle', 'commands');
    expect(commandView(Array.isArray(command) ? command[0] : undefined).decision).toMatchObject({
      row: 'K6',
      line: 'battle_record_closed',
    });
    expect(fake.writes()).toHaveLength(1);
    data.stop();
  });
});

describe('INV-1 / OD-13 through the wired data layer (9.1 X2a, X2b)', () => {
  it('X2b: no read and no session record names the emulator: the Pause click sends nothing and says so; Turn input off still posts', async () => {
    const { fake, data } = bootDashboard({
      before: (transport) => {
        transport.route('GET', '/api/status', () => ({ status: 502, body: 'Bad gateway' }));
        transport.route('GET', '/api/config', () => ({ status: 502, body: 'Bad gateway' }));
        transport.route('GET', '/api/harvest', () => ({ status: 502, body: 'Bad gateway' }));
      },
    });
    await flush();
    await data.commands.pause();
    expect(
      fake.requests.filter((entry) => entry.method === 'GET').map((entry) => entry.path),
    ).toEqual(expect.arrayContaining(['/api/config', '/api/harvest']));
    expect(fake.writes()).toEqual([]);
    expect(selectOutcomes(data.store.getSnapshot()).notices).toMatchObject([
      { kind: 'pause_not_sent', reason: 'context_not_named' },
    ]);
    await data.commands.turnInputOff();
    expect(fake.writes().map((entry) => [entry.path, entry.body])).toEqual([
      ['/api/automation-access', '{"enabled":false}'],
    ]);
    data.stop();
  });

  it('X2a: the click reads config, sends the E0 body once, and the "not sent" line goes', async () => {
    let configOk = false;
    const { fake, data } = bootDashboard({
      before: (transport) => {
        transport.route('GET', '/api/status', () => ({ status: 502, body: 'Bad gateway' }));
        transport.route('GET', '/api/config', () =>
          configOk
            ? {
                status: 200,
                body: { active_instance: 'main', instances: { main: { serial: 'fake:1' } } },
              }
            : { status: 502, body: 'Bad gateway' },
        );
        transport.route('GET', '/api/harvest', () => ({ status: 502, body: 'Bad gateway' }));
      },
    });
    await flush();
    await data.commands.pause();
    configOk = true;
    await data.commands.pause();
    expect(fake.writes().map((entry) => JSON.parse(entry.body ?? '{}') as unknown)).toEqual([
      {
        enabled: false,
        expected_context: { instance: 'main', serial: 'fake:1' },
        idempotency_key: 'key-0001',
      },
    ]);
    expect(selectOutcomes(data.store.getSnapshot()).notices).toEqual([]);
    data.stop();
  });
});

describe('the read plan follows the store (spec 7.2)', () => {
  it('reads status at 500 ms while a write is unresolved and at 2500 ms otherwise', async () => {
    const { data } = bootDashboard();
    await vi.advanceTimersByTimeAsync(3000);
    expect(selectReadPlan(data.store.getSnapshot(), 'status').mode).toBe('idle');
    await data.commands.turnInputOff();
    expect(selectReadPlan(data.store.getSnapshot(), 'status').mode).toBe('active');
    data.stop();
  });

  it('an input answer asks for a later config read; a write answer asks for a later status read', async () => {
    const { fake, data } = bootDashboard();
    await vi.advanceTimersByTimeAsync(3000);
    const configReads = () => fake.requests.filter((entry) => entry.path === '/api/config').length;
    const statusReads = () => fake.requests.filter((entry) => entry.path === '/api/status').length;
    const config = configReads();
    const status = statusReads();
    await data.commands.turnInputOff();
    fake.last('/api/automation-access').respond(200, {
      enabled: false,
      ok: true,
      revocation: {
        config_persisted: true,
        errors: [],
        fenced: true,
        harvest: { paused: false, revision: null },
        latched: true,
        revoked_at: 1800000000.0,
        state: 'nothing_running',
        still_owned: [],
        stopped: [],
        stopping: [],
      },
    });
    await flush();
    expect(configReads()).toBe(config + 1);
    expect(statusReads()).toBe(status + 1);
    data.stop();
  });

  it('a visible tab again reads status, calibration, the active battle and the workspace data once', async () => {
    const { fake, data, visibility } = bootDashboard();
    await vi.advanceTimersByTimeAsync(3000);
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const before = fake.requests.length;
    visibility.set(false);
    await flush();
    const paths = fake.requests.slice(before).map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/status',
        '/api/calibrate/status',
        '/api/battles/active',
        '/api/config',
        '/api/accounts',
        '/api/runs',
        '/api/wizard/tools',
        '/api/wizard/state',
      ]),
    );
    expect(data.store.getSnapshot().hidden).toBe(false);
    data.stop();
  });
});
