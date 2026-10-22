import { readEndpoint } from './client.ts';
import { contextFromConfig, type PageContext } from './context.ts';
import { GET_TIMEOUT_MS } from './poller.ts';
import { browserTimers, type Timers } from './timers.ts';
import type { Transport } from './transport.ts';
import type { Endpoint } from './wire.ts';

/** A new config read for each explicit click, never joined to an earlier read. */
export function createClickTimeContextRead(
  transport: Transport,
  config: Endpoint,
  timers: Timers = browserTimers,
) {
  return async (signal?: AbortSignal): Promise<PageContext | null> => {
    const controller = new AbortController();
    const timeout = timers.setTimeout(() => {
      controller.abort();
    }, GET_TIMEOUT_MS);
    try {
      const outcome = await readEndpoint(
        transport,
        config,
        '/api/config',
        signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
      );
      if (outcome.kind !== 'answered' || outcome.answer.status !== 200) return null;
      return contextFromConfig(outcome.answer.body);
    } finally {
      timers.clearTimeout(timeout);
    }
  };
}
