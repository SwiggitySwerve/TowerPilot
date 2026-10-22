import { readEndpoint } from './client.ts';
import { contextFromConfig, type PageContext } from './context.ts';
import { ownPath } from '../core/read.ts';
import { GET_TIMEOUT_MS } from './poller.ts';
import { browserTimers, type Timers } from './timers.ts';
import type { Transport } from './transport.ts';
import type { Endpoint } from './wire.ts';

/** A new config read for each explicit click, never joined to an earlier read. */
function createClickTimeConfigRead<T>(
  transport: Transport,
  config: Endpoint,
  project: (body: unknown) => T | null,
  timers: Timers,
) {
  return async (signal?: AbortSignal): Promise<T | null> => {
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
      return project(outcome.answer.body);
    } finally {
      timers.clearTimeout(timeout);
    }
  };
}

export interface LaunchContext extends PageContext {
  readonly rendering: unknown;
}

/** `instances.<instance>.rendering` of a config body (an object, or null when absent). */
export function configRendering(body: unknown, instance: string): unknown {
  return ownPath(body, 'instances', instance, 'rendering') ?? null;
}

/** The C5 launch fence, including the rendering descriptor from this exact config body. */
export function launchContextFromConfig(body: unknown): LaunchContext | null {
  const context = contextFromConfig(body);
  return context === null
    ? null
    : { ...context, rendering: configRendering(body, context.instance) };
}

/** Existing editor callers retain their four-field page context. */
export function createClickTimeContextRead(
  transport: Transport,
  config: Endpoint,
  timers: Timers = browserTimers,
) {
  return createClickTimeConfigRead(transport, config, contextFromConfig, timers);
}

export function createClickTimeLaunchContextRead(
  transport: Transport,
  config: Endpoint,
  timers: Timers = browserTimers,
) {
  return createClickTimeConfigRead(transport, config, launchContextFromConfig, timers);
}
