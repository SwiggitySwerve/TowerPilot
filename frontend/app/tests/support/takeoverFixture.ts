import { takeoverCase, takeoverCaseNames } from './takeover-fixtures.mjs';

/** A recorded takeover case `<scenario>.<case>`: its status, request (POST cases) and body. */
export function takeoverRecorded(path: string): {
  status: number;
  request: unknown;
  body: Record<string, unknown>;
} {
  return takeoverCase(path);
}

export { takeoverCaseNames };
